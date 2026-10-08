/**
 * Postgres write helpers for TypeScript callers — the mirror of
 * packages/etl-db-writer/db_writer.py, and deliberately semantically identical
 * to it rather than merely similar.
 *
 * Why `ingest()` takes a callback instead of exposing `ingestFile()`
 * -----------------------------------------------------------------
 * This file previously offered `ingestFile()` / `writeRecord()` / `writeRecords()`
 * as independent calls, exactly like the Python module did, and inherited the
 * same defect: the `ingested_files` ledger row was written before the file's
 * `forensic_records`, dedup was keyed on that row merely existing
 *
 *     SELECT 1 FROM ingested_files WHERE file_hash = $1 LIMIT 1
 *     -> alreadyIngested: true, caller skips the file entirely
 *
 * and nothing tied the two writes into one transaction. Any failure in between
 * left a ledger row claiming a file was ingested while none of its records
 * existed. Every later run then skipped it, reported success, and the evidence
 * was permanently absent from a chain-of-custody database with no error
 * anywhere.
 *
 * The TypeScript version had it worse in one respect: it issued no BEGIN at
 * all, so under node-postgres's default autocommit every statement committed
 * on its own. There was not even a transaction to lose.
 *
 * `ingest()` now owns the boundary. It BEGINs, hands the caller a unit, and
 * COMMITs only after marking the ledger row complete with its record count —
 * or ROLLBACKs everything, ledger row included, so the next run retries the
 * file. No exported function commits a ledger row on its own, so the old
 * sequence cannot be reassembled by a caller.
 *
 * `writeRecord`/`writeRecords` are still exported for use inside a unit and no
 * longer manage transactions themselves.
 */
 
import * as crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Client, PoolClient } from 'pg';
 
import { NormalizedRecord as NormalizedRecordSchema } from '@verichron/contracts';
import type { NormalizedRecord as NormalizedRecordShape } from '@verichron/contracts';
 
export const DEFAULT_DB_URL = 'postgresql://forensics:forensics_dev_only@localhost:5432/forensics';
 
type Db = Client | PoolClient;
 
/**
 * sha256 of file contents — the idempotency key for ingested_files.
 *
 * Streamed rather than `readFile`d: this hashes SMS attachments and gcloud log
 * exports, and the previous implementation buffered the entire file into memory
 * just to hash it, which the Python side had already avoided. Node also caps a
 * single Buffer well below the size of a full backup artifact, so the old
 * version would throw outright on a large enough file.
 */
export async function computeFileHash(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
 
  return new Promise<string>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
 
/**
 * Who an ingest is stamped with: the evidence, the derivative being read, and
 * the run doing the reading. Built once from the orchestrator's arguments and
 * passed to every `ingest()` call, so extractor code never labels facts itself
 * (R16). Mirrors `IngestContext` in db_writer.py.
 */
export interface IngestContext {
  evidenceId: string;
  derivativeId: string;
  runId: string;
  /** The stage's parserVersion from its stage.json, via the orchestrator (EPOCH-404). */
  parserVersion: number;
}

export const PAYLOAD_KINDS = ['full', 'summary', 'none'] as const;
export type PayloadKind = (typeof PAYLOAD_KINDS)[number];

export interface IngestParams {
  filePath: string;
  sourceType: string;
  /** What `rawPayload` holds (R12). */
  payloadKind: PayloadKind;
  /** Attach now if known; otherwise call `unit.setRawPayload()` after parsing. */
  rawPayload?: Record<string, unknown>;
}

/**
 * Validate the caller's context and return a frozen copy of its three IDs.
 *
 * ingest() reads identity across several awaits and again inside
 * `unit.write()`. Holding the caller's object would let a caller that reuses
 * it for the next evidence item, mid-ingest, split one unit across two
 * evidence items: the ledger row under one, its records or run label under
 * the other. Python gets this from a frozen dataclass; here it's a copy.
 */
function fixContext(ctx: IngestContext): Readonly<IngestContext> {
  for (const key of ['evidenceId', 'derivativeId', 'runId'] as const) {
    if (!ctx?.[key]) {
      throw new Error(
        `IngestContext.${key} is required: an ingest cannot happen before evidence is ` +
          `registered (EPOCH-404's pre-flight step)`
      );
    }
  }
  if (!Number.isInteger(ctx.parserVersion) || ctx.parserVersion < 1) {
    throw new Error(`IngestContext.parserVersion must be an integer >= 1, got ${ctx.parserVersion}`);
  }
  return Object.freeze({
    evidenceId: ctx.evidenceId,
    derivativeId: ctx.derivativeId,
    runId: ctx.runId,
    parserVersion: ctx.parserVersion,
  });
}

/**
 * One file's worth of work, inside one transaction. Nothing here commits.
 */
export class IngestUnit {
  public recordsWritten = 0;

  constructor(
    private readonly client: Db,
    private readonly ctx: Readonly<IngestContext>,
    public readonly filePath: string,
    public readonly fileHash: string,
    public readonly ingestId: string,
    /** True only when a previous run marked this unit COMPLETE. */
    public readonly alreadyIngested: boolean
  ) {}

  /** Write validated records for this file. Callable more than once. */
  public async write(records: NormalizedRecordShape[]): Promise<number> {
    this.guard();
    const written = await writeRecords(this.client, this.ingestId, this.ctx.evidenceId, records);
    this.recordsWritten += written;
    return written;
  }

  public async writeOne(record: NormalizedRecordShape): Promise<void> {
    this.guard();
    await writeRecord(this.client, this.ingestId, this.ctx.evidenceId, record);
    this.recordsWritten += 1;
  }

  /**
   * Attach the parsed payload to the ledger row, in this same transaction.
   * For extractors that can only build the payload after parsing.
   */
  public async setRawPayload(payload: Record<string, unknown>): Promise<void> {
    this.guard();
    await this.client.query('UPDATE ingested_files SET raw_payload = $1 WHERE ingest_id = $2', [
      payload,
      this.ingestId,
    ]);
  }

  private guard(): void {
    if (this.alreadyIngested) {
      throw new Error(
        `${this.filePath}: this file is already fully ingested for this evidence and ` +
          `parser version (file_hash ${this.fileHash.slice(0, 12)}). Check ` +
          `\`alreadyIngested\` and return before writing; writing here would duplicate ` +
          `records that are already committed.`
      );
    }
  }
}

export interface IngestOutcome<T> {
  fileHash: string;
  ingestId: string;
  alreadyIngested: boolean;
  recordsWritten: number;
  /** Whatever the body returned. */
  value: T;
}

/** Record this run on the unit's produced_by_runs (R7), once. Audit only. */
async function labelRun(client: Db, ctx: Readonly<IngestContext>, ingestId: string): Promise<void> {
  await client.query(
    `UPDATE ingested_files
        SET produced_by_runs = array_append(produced_by_runs, $1::uuid)
      WHERE ingest_id = $2 AND NOT ($3::uuid = ANY(produced_by_runs))`,
    [ctx.runId, ingestId, ctx.runId]
  );
}

/**
 * Atomic ingest of one file: ledger row + records + completion flag, or nothing.
 *
 * ```ts
 * await ingest(client, ctx, { filePath, sourceType, payloadKind }, async (unit) => {
 *   if (unit.alreadyIngested) return;
 *   await unit.write(records);
 * });
 * ```
 *
 * Guarantees, matching db_writer.py exactly:
 *
 * - A unit is (evidence_id, file_hash, source_type, parser_version) (R6, R8).
 * - On clean return the ledger row is marked complete with its record count and
 *   the whole unit commits together.
 * - On a thrown error everything rolls back, ledger row included, so the file
 *   has no trace in the ledger and the next run retries it.
 * - `alreadyIngested` is true only when a previous run marked the unit complete.
 * - Every attempt that ends cleanly adds ctx.runId to produced_by_runs; a
 *   completed unit's other columns are never rewritten.
 * - An abandoned unit (row present, not complete) is reclaimed: orphaned records
 *   are deleted and it is re-ingested, so a retry cannot double-count.
 */
export async function ingest<T>(
  client: Db,
  callerCtx: IngestContext,
  params: IngestParams,
  body: (unit: IngestUnit) => Promise<T>
): Promise<IngestOutcome<T>> {
  // Every use of identity below reads this frozen copy, never callerCtx.
  const ctx = fixContext(callerCtx);
  const { filePath, sourceType, payloadKind, rawPayload } = params;
  const { parserVersion } = ctx;
  if (!PAYLOAD_KINDS.includes(payloadKind)) {
    throw new Error(`payloadKind must be one of ${PAYLOAD_KINDS.join(', ')}, got ${payloadKind}`);
  }
  const fileHash = await computeFileHash(filePath);

  // Fast path for a re-run: the unit is already complete. Read outside a
  // transaction, which is safe because ingest_complete is monotonic -- a true
  // seen here cannot be invalidated. A false may be stale, which is why it
  // falls through to the locking upsert rather than being acted on.
  const preflight = await client.query<{ ingest_id: string; ingest_complete: boolean }>(
    `SELECT ingest_id, ingest_complete FROM ingested_files
      WHERE evidence_id = $1 AND file_hash = $2 AND source_type = $3 AND parser_version = $4`,
    [ctx.evidenceId, fileHash, sourceType, parserVersion]
  );

  const done = preflight.rows[0];
  if (done?.ingest_complete) {
    const unit = new IngestUnit(client, ctx, filePath, fileHash, done.ingest_id, true);
    const value = await body(unit);
    // A dedup hit still records that this run saw the unit (R7). Autocommits;
    // a no-op when the run is already listed.
    await labelRun(client, ctx, done.ingest_id);
    return { fileHash, ingestId: done.ingest_id, alreadyIngested: true, recordsWritten: 0, value };
  }

  await client.query('BEGIN');

  try {
    // Upsert-and-lock. Returns the row's id and completion state either way. A
    // row that is already complete keeps every original value: a finished
    // ingest is immutable audit data.
    const claimed = await client.query<{ ingest_id: string; ingest_complete: boolean }>(
      `INSERT INTO ingested_files
         (evidence_id, derivative_id, file_hash, source_type, parser_version,
          file_path, file_name, payload_kind, raw_payload, produced_by_runs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ARRAY[$10::uuid])
       ON CONFLICT (evidence_id, file_hash, source_type, parser_version) DO UPDATE SET
         derivative_id = CASE WHEN ingested_files.ingest_complete
                              THEN ingested_files.derivative_id ELSE EXCLUDED.derivative_id END,
         file_path     = CASE WHEN ingested_files.ingest_complete
                              THEN ingested_files.file_path     ELSE EXCLUDED.file_path     END,
         file_name     = CASE WHEN ingested_files.ingest_complete
                              THEN ingested_files.file_name     ELSE EXCLUDED.file_name     END,
         payload_kind  = CASE WHEN ingested_files.ingest_complete
                              THEN ingested_files.payload_kind  ELSE EXCLUDED.payload_kind  END,
         raw_payload   = CASE WHEN ingested_files.ingest_complete
                              THEN ingested_files.raw_payload   ELSE EXCLUDED.raw_payload   END,
         ingested_at   = CASE WHEN ingested_files.ingest_complete
                              THEN ingested_files.ingested_at   ELSE now()                  END
       RETURNING ingest_id, ingest_complete`,
      [
        ctx.evidenceId,
        ctx.derivativeId,
        fileHash,
        sourceType,
        parserVersion,
        filePath,
        filePath.split(/[\\/]/).pop() ?? filePath,
        payloadKind,
        rawPayload ?? {},
        ctx.runId,
      ]
    );

    const ingestId = claimed.rows[0].ingest_id;
    const alreadyIngested = claimed.rows[0].ingest_complete === true;

    if (!alreadyIngested) {
      // Reclaim an abandoned unit. A no-op for a row just inserted; for a
      // stranded one it clears partial records so this attempt's write is the
      // only contribution.
      await client.query('DELETE FROM forensic_records WHERE ingest_id = $1', [ingestId]);
    }

    const unit = new IngestUnit(client, ctx, filePath, fileHash, ingestId, alreadyIngested);
    const value = await body(unit);

    if (!alreadyIngested) {
      await client.query(
        `UPDATE ingested_files
            SET ingest_complete = TRUE,
                record_count    = $1,
                completed_at    = now()
          WHERE ingest_id = $2`,
        [unit.recordsWritten, ingestId]
      );
    }
    // Fresh, reclaimed, or completed by another process between the preflight
    // read and the upsert: either way this run saw the unit.
    await labelRun(client, ctx, ingestId);
    await client.query('COMMIT');

    return {
      fileHash,
      ingestId,
      alreadyIngested,
      recordsWritten: alreadyIngested ? 0 : unit.recordsWritten,
      value,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Surface the original failure, not the rollback's. A rollback that fails
      // usually means the connection is already gone, in which case the server
      // aborts the transaction anyway and the atomicity guarantee still holds.
      console.error('[dbWriter] ROLLBACK failed after an ingest error:', rollbackError);
    }
    throw error;
  }
}

/**
 * Insert one validated NormalizedRecord into forensic_records.
 *
 * Does NOT manage a transaction — the caller owns the boundary, normally by
 * being inside an `ingest()` unit, which supplies ingestId and evidenceId.
 */
export async function writeRecord(
  client: Db,
  ingestId: string,
  evidenceId: string,
  record: NormalizedRecordShape
): Promise<void> {
  const validated = NormalizedRecordSchema.parse(record);

  await client.query(
    `INSERT INTO forensic_records
      (ingest_id, evidence_id, incident_id, source_type, event_time,
       bug_type, process_name, pid, bundle_id, fields)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      ingestId,
      evidenceId,
      validated.incident_id ?? null,
      validated.source_type,
      validated.event_time ?? null,
      validated.bug_type ?? null,
      validated.process_name ?? null,
      validated.pid ?? null,
      validated.bundle_id ?? null,
      validated.fields,
    ]
  );
}

/**
 * Bulk form of writeRecord. Does NOT manage a transaction.
 *
 * Chunked, because Postgres caps bind parameters at 65535: a single statement
 * with ten placeholders per record fails outright past 6553 records.
 */
const MAX_PARAMS_PER_STATEMENT = 65535;
const COLUMNS_PER_RECORD = 10;
export const MAX_RECORDS_PER_STATEMENT = Math.floor(MAX_PARAMS_PER_STATEMENT / COLUMNS_PER_RECORD);

export async function writeRecords(
  client: Db,
  ingestId: string,
  evidenceId: string,
  records: NormalizedRecordShape[]
): Promise<number> {
  if (records.length === 0) {
    return 0;
  }

  for (let offset = 0; offset < records.length; offset += MAX_RECORDS_PER_STATEMENT) {
    const chunk = records.slice(offset, offset + MAX_RECORDS_PER_STATEMENT);
    const values: string[] = [];
    const params: unknown[] = [];

    chunk.forEach((record, index) => {
      const validated = NormalizedRecordSchema.parse(record);
      const base = index * COLUMNS_PER_RECORD;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`
      );
      params.push(
        ingestId,
        evidenceId,
        validated.incident_id ?? null,
        validated.source_type,
        validated.event_time ?? null,
        validated.bug_type ?? null,
        validated.process_name ?? null,
        validated.pid ?? null,
        validated.bundle_id ?? null,
        validated.fields
      );
    });

    await client.query(
      `INSERT INTO forensic_records
        (ingest_id, evidence_id, incident_id, source_type, event_time,
         bug_type, process_name, pid, bundle_id, fields)
       VALUES ${values.join(', ')}`,
      params
    );
  }

  return records.length;
}

/**
 * Ledger rows that were started and never finished.
 *
 * Expected to be empty. Non-empty means a hard kill mid-unit, or rows the 0002
 * migration could not classify — files predating the atomicity fix that have no
 * records, which may be legitimately empty or may be ones the old code lost.
 * Either way the next run retries them; this exists so an operator can see them
 * rather than infer them, since the failure mode being fixed never announced
 * itself.
 */
export async function incompleteIngests(
  client: Db
): Promise<{ fileHash: string; filePath: string }[]> {
  const result = await client.query<{ file_hash: string; file_path: string }>(
    `SELECT file_hash, file_path
       FROM ingested_files
      WHERE NOT ingest_complete
      ORDER BY ingested_at, ingest_id`
  );
  return result.rows.map((row) => ({ fileHash: row.file_hash, filePath: row.file_path }));
}