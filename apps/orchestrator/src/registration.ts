/**
 * Pre-flight evidence registration (EPOCH-404).
 *
 * Runs BEFORE a pipeline run is created. A sidecar that is missing, malformed
 * or doesn't match its manifest stops here, so it never leaves an orphaned
 * pipeline_runs row behind, and every run that does start carries the
 * evidence and derivative it processed.
 *
 * Steps, in order:
 *   1. Locate the evidence files from the decrypted path's workspace and label.
 *   2. Validate the sidecar against the EvidenceSidecar contract (EPOCH-401).
 *   3. Recompute content_root from the manifest file (cheap; no access to the
 *      source backup needed) and require it to match the sidecar.
 *   4. Read the device's UDID from Info.plist and key the device by
 *      HMAC-SHA256(UDID, per-install secret). The raw UDID is never stored.
 *   5. In one transaction: upsert the device, the evidence item (by
 *      content_root), the location and the derivatives (the decrypt, and the
 *      iLEAPP output made from it, when complete), appending
 *      an evidence_events row for each thing that is new.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Client } from 'pg';

import {
  DECRYPT_MARKER,
  EvidenceSidecar,
  WorkspaceManifestError,
  provenanceKey,
  readDecryptMarker,
  readIleappMarker,
  readCrashReportsMarker,
  readPlistValues,
  resolveWorkspaceBackup,
  resolveWorkspacePath,
  workspaceEvidenceManifestPath,
  type DerivativeKind,
  type ResolvedWorkspaceBackup,
  type StageInput,
  type ToolVersion,
} from '@verichron/contracts';

import type { StageDefinition } from './types.js';

/** Registration refused: the run must not start. The message says why. */
export class RegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationError';
  }
}

export interface Registration {
  evidenceId: string;
  deviceId: string;
  /** The decrypted backup this run reads. */
  decryptedDerivativeId: string;
  /** iLEAPP's output for that decrypt, when complete (EPOCH-416). */
  ileappDerivativeId: string | null;
  /** The device's crash logs, when the pull acquired them with this backup
   * (EPOCH-514); an iOS backup holds none itself (EPOCH-447). */
  crashReportsDerivativeId: string | null;
}

export type RegisteredDerivatives = Pick<
  Registration,
  'decryptedDerivativeId' | 'ileappDerivativeId' | 'crashReportsDerivativeId'
>;

/**
 * Inputs whose absence is a fact, not a step left undone: derivatives that
 * only some acquisitions produce (EPOCH-447), and an indicator set, which none
 * may be registered yet (EPOCH-491). A stage whose input is absent is recorded
 * as skipped with this reason, and the report lists it as not examined; resume
 * accepts such a skip only by this exact reason, never a disabled stage's.
 * Every other missing derivative fails the stage.
 */
const NOT_ACQUIRED: Partial<Record<StageInput, string>> = {
  crash_reports:
    "Crash logs were not acquired for this evidence. An iOS backup does not contain the device's crash logs; " +
    'they are copied from the device separately.',
  indicator_set: 'No indicator set is registered, so indicators were not checked.',
};

/** The reason a stage is skipped when its input is absent, or null when an absent input fails it. */
export function absentInputReason(stage: StageDefinition): string | null {
  return NOT_ACQUIRED[stage.manifest.reads] ?? null;
}

/**
 * The derivative a stage reads, as its stage.json declares; null when that one
 * isn't registered, and for a stage that checks an indicator set, which reads
 * no derivative (EPOCH-491).
 */
export function derivativeFor(stage: StageDefinition, registration: RegisteredDerivatives): string | null {
  const reads = stage.manifest.reads;
  if (reads === 'indicator_set') return null;
  const byKind: Record<DerivativeKind, string | null> = {
    decrypted: registration.decryptedDerivativeId,
    ileapp_output: registration.ileappDerivativeId,
    crash_reports: registration.crashReportsDerivativeId,
  };
  return byKind[reads];
}

/** What a stage reads in one run: a derivative or an indicator set, and the reason if it's absent. */
export interface StageInputs {
  derivativeId: string | null;
  indicatorSetId: string | null;
  /** Set only when the input is absent and that absence is a fact (NOT_ACQUIRED): the stage is skipped with it. */
  absentReason: string | null;
}

/**
 * The input a stage reads in this run (EPOCH-491): its derivative, or, for a
 * stage that reads an indicator set, the set the run checks. One function, so
 * the run's stage rows and the resume check can't disagree.
 */
export function inputsFor(
  stage: StageDefinition,
  registration: RegisteredDerivatives,
  indicatorSet: { setId: string } | null
): StageInputs {
  if (stage.manifest.reads === 'indicator_set') {
    const indicatorSetId = indicatorSet?.setId ?? null;
    return { derivativeId: null, indicatorSetId, absentReason: indicatorSetId ? null : absentInputReason(stage) };
  }
  const derivativeId = derivativeFor(stage, registration);
  return { derivativeId, indicatorSetId: null, absentReason: derivativeId ? null : absentInputReason(stage) };
}

/** What made a derivative, as its completion marker records it (EPOCH-406). */
interface Provenance {
  tool: ToolVersion;
  params: unknown;
}

export interface RegistrationInput {
  /** All evidence and derivative locations resolved from workspace.json. */
  target: ResolvedWorkspaceBackup;
  /** Recorded on locations and events; defaults to this machine's hostname. */
  host?: string;
  /** Per-install HMAC secret file; defaults to defaultSecretPath(). */
  secretPath?: string;
}

// ---------------------------------------------------------------------------
// Per-install device-key secret
// ---------------------------------------------------------------------------

/** ~/.config/verichron/device-key.secret, honoring XDG_CONFIG_HOME. Never in
 * the database: anyone who can read the database could otherwise recompute
 * UDIDs from candidate values. */
export function defaultSecretPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'verichron', 'device-key.secret');
}

/**
 * Read the secret, creating it (32 random bytes, hex, mode 0600) on first use.
 * A secret readable by group or others is refused rather than used.
 *
 * Creation is atomic and never clobbers: the secret is fully written to a
 * private temp file, then hard-linked into place. link() fails if the name
 * exists, so when two processes race on first use, exactly one secret wins
 * and nobody can observe it half-written.
 */
export function loadDeviceSecret(secretPath: string = defaultSecretPath()): Buffer {
  if (!existsSync(secretPath)) {
    mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
    const staging = `${secretPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(staging, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    try {
      linkSync(staging, secretPath);
    } catch (err) {
      // Another process published its secret first; use that one.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    } finally {
      unlinkSync(staging);
    }
  }
  if (process.platform !== 'win32' && (statSync(secretPath).mode & 0o077) !== 0) {
    throw new RegistrationError(
      `${secretPath} is readable by other users; restrict it with "chmod 600" before registering evidence`
    );
  }
  const hex = readFileSync(secretPath, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new RegistrationError(`${secretPath} is not a 64-character hex secret`);
  }
  return Buffer.from(hex, 'hex');
}

export function deviceKey(udid: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(udid.trim().toUpperCase(), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Info.plist
// ---------------------------------------------------------------------------

/**
 * Top-level strings (and dates) of an XML Info.plist, read by the contract's
 * one reader. A binary property list is refused rather than guessed at.
 */
export function readPlistStrings(file: string): Map<string, string> {
  try {
    return readPlistValues(file);
  } catch (err) {
    throw new RegistrationError(err instanceof Error ? err.message : String(err));
  }
}

function readDevice(candidates: string[]): { udid: string; name: string } {
  const plistPath = candidates.map((dir) => path.join(dir, 'Info.plist')).find((p) => existsSync(p));
  if (!plistPath) {
    throw new RegistrationError(`no Info.plist in ${candidates.join(' or ')}; cannot identify the device`);
  }
  const keys = readPlistStrings(plistPath);
  const udid = keys.get('Unique Identifier') || keys.get('Target Identifier');
  if (!udid) {
    // "GUID" is deliberately not accepted: in an iTunes/Finder backup it is
    // an iTunes-assigned backup GUID, not the device's UDID, so keying the
    // device by it would file the evidence under the wrong identity.
    const guidNote = keys.has('GUID') ? ' ("GUID" is the backup\'s iTunes GUID, not the device UDID)' : '';
    throw new RegistrationError(`${plistPath} has no "Unique Identifier" or "Target Identifier"${guidNote}`);
  }
  return { udid, name: keys.get('Device Name') || keys.get('Display Name') || 'Unknown device' };
}

// ---------------------------------------------------------------------------
// Evidence files
// ---------------------------------------------------------------------------

interface VerifiedSidecar {
  contentRoot: string;
  fileCount: number;
  totalBytes: number;
  sourcePath: string;
  hashedAt: string;
}

function verifySidecar(target: ResolvedWorkspaceBackup): VerifiedSidecar {
  if (!existsSync(target.sidecarPath)) {
    throw new RegistrationError(
      `no evidence sidecar at ${target.sidecarPath}; re-run the processor so the backup is hashed (EPOCH-401)`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(target.sidecarPath, 'utf8'));
  } catch (err) {
    throw new RegistrationError(`${target.sidecarPath} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = EvidenceSidecar.safeParse(raw);
  if (!parsed.success) {
    throw new RegistrationError(
      `${target.sidecarPath} does not match the evidence sidecar contract: ${parsed.error.message}`
    );
  }
  const sidecar = parsed.data;
  if (sidecar.evidence_name !== target.label) {
    throw new RegistrationError(`${target.sidecarPath} describes "${sidecar.evidence_name}", not "${target.label}"`);
  }
  if (path.resolve(sidecar.source_path) !== path.resolve(target.sourcePath)) {
    throw new RegistrationError(
      `${target.sidecarPath} source_path does not match the workspace manifest entry for "${target.label}"`
    );
  }

  // The manifest must be the content-addressed one for this very root, inside
  // this label's evidence directory: no path tricks, no swapped files.
  let manifestPath: string;
  try {
    manifestPath = resolveWorkspacePath(target.workspace, sidecar.manifest_path);
  } catch (error) {
    if (error instanceof WorkspaceManifestError) {
      throw new RegistrationError(
        `${target.sidecarPath} has an invalid manifest_path "${sidecar.manifest_path}": ${error.message}`
      );
    }
    throw error;
  }
  const expectedManifestPath = workspaceEvidenceManifestPath(target, sidecar.content_root);
  if (manifestPath !== expectedManifestPath) {
    throw new RegistrationError(
      `${target.sidecarPath} points its manifest at ${sidecar.manifest_path}, expected ` +
        path.relative(target.workspace, expectedManifestPath)
    );
  }
  if (!existsSync(manifestPath)) {
    throw new RegistrationError(`manifest ${manifestPath} named by the sidecar does not exist`);
  }
  const recomputed = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
  if (recomputed !== sidecar.content_root) {
    throw new RegistrationError(
      `manifest ${manifestPath} hashes to ${recomputed}, but the sidecar says ${sidecar.content_root}; ` +
        'the evidence record cannot be verified'
    );
  }
  return {
    contentRoot: sidecar.content_root,
    fileCount: sidecar.file_count,
    totalBytes: sidecar.total_bytes,
    sourcePath: sidecar.source_path,
    hashedAt: sidecar.hashed_at,
  };
}

/**
 * Each derivative must have been made from THIS evidence: its completion
 * marker records the content_root it came from. A decrypt or iLEAPP output
 * left over from an earlier version of the backup under the same label is
 * refused, so its facts can't be filed under the new evidence.
 *
 * Returns each derivative's provenance from its marker, and the iLEAPP
 * directory to register, or null if it isn't complete
 * (stages that read it then fail clearly before they start).
 */
function verifyDerivatives(
  decryptedPath: string,
  ileappPath: string | undefined,
  crashReportsPath: string | undefined,
  contentRoot: string
): { decrypt: Provenance; ileapp: MadeFromDecrypt | null; crashReports: MadeFromDecrypt | null } {
  const decrypt = readDecryptMarker(decryptedPath);
  if (decrypt?.content_root !== contentRoot) {
    throw new RegistrationError(
      decrypt
        ? `the decrypted copy at ${decryptedPath} was made from content root ${decrypt.content_root.slice(0, 12)}…, ` +
            `but the evidence sidecar names ${contentRoot.slice(0, 12)}…; re-run the processor to re-decrypt`
        : `${decryptedPath} has no valid ${DECRYPT_MARKER} recording which evidence it was decrypted from; ` +
            're-run the processor'
    );
  }

  return {
    decrypt: { tool: decrypt.tool, params: decrypt.params },
    ileapp: madeFromDecrypt("iLEAPP's output", ileappPath, readIleappMarker, contentRoot),
    // Not made from the decrypt but acquired with the backup, in the same
    // pull; checked the same way: its marker must name this evidence.
    crashReports: madeFromDecrypt('the crash-log copy', crashReportsPath, readCrashReportsMarker, contentRoot),
  };
}

interface MadeFromDecrypt {
  path: string;
  provenance: Provenance;
}

/**
 * A derivative the processor makes from the decrypt, if it is complete: null
 * when its directory or completion marker is missing, refused when its
 * marker names other evidence.
 */
function madeFromDecrypt(
  what: string,
  dir: string | undefined,
  readMarker: (dir: string) => { content_root: string; tool: ToolVersion; params: unknown } | null,
  contentRoot: string
): MadeFromDecrypt | null {
  if (!dir || !existsSync(dir)) return null;
  if (!statSync(dir).isDirectory()) {
    throw new RegistrationError(`${what} path ${dir} exists but is not a directory`);
  }
  const marker = readMarker(dir);
  if (!marker) return null;
  if (marker.content_root !== contentRoot) {
    throw new RegistrationError(
      `${what} at ${dir} was made from content root ${marker.content_root.slice(0, 12)}…, ` +
        `but the evidence sidecar names ${contentRoot.slice(0, 12)}…; re-run the processor`
    );
  }
  return { path: path.resolve(dir), provenance: { tool: marker.tool, params: marker.params } };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

async function appendEvent(
  client: Client,
  evidenceId: string,
  kind: string,
  host: string,
  detail: Record<string, unknown>
): Promise<void> {
  await client.query(`INSERT INTO evidence_events (evidence_id, kind, host, detail) VALUES ($1, $2, $3, $4)`, [
    evidenceId,
    kind,
    host,
    detail,
  ]);
}

/**
 * A derivative's identity is (evidence, kind, parent, provenance), not its
 * path (migration 0007). A pass made by a different tool version, with a
 * different repair outcome or with a different iLEAPP input type is a new
 * derivative; a row's tool is never rewritten. The path is its last-known
 * location, so a moved workspace keeps its derivative (and its completed
 * runs). A repeated pass with the same identity refreshes the row's params,
 * whose preserved originals' timestamped names are the current files'
 * (EPOCH-517); its provenance key is the same by definition.
 */
async function upsertDerivative(
  client: Client,
  evidenceId: string,
  kind: DerivativeKind,
  derivativePath: string,
  parentId: string | null,
  host: string,
  provenance: Provenance
): Promise<string> {
  const key = provenanceKey(provenance.tool, provenance.params);
  const { rows } = await client.query<{ derivative_id: string; inserted: boolean }>(
    `INSERT INTO evidence_derivatives (evidence_id, kind, path, parent_derivative_id, tool, params, provenance_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (evidence_id, kind, parent_derivative_id, provenance_key)
       DO UPDATE SET path = EXCLUDED.path, params = EXCLUDED.params
     RETURNING derivative_id, (xmax = 0) AS inserted`,
    [evidenceId, kind, derivativePath, parentId, provenance.tool, provenance.params, key]
  );
  if (rows[0].inserted) {
    await appendEvent(client, evidenceId, 'derivative_registered', host, {
      derivative_id: rows[0].derivative_id,
      kind,
      path: derivativePath,
      tool: provenance.tool,
      provenance_key: key,
    });
  }
  return rows[0].derivative_id;
}

/**
 * Register the evidence behind one decrypted backup, before any run exists.
 * Throws RegistrationError for anything unverifiable; every database write
 * happens in one transaction, so a failure leaves nothing half-registered.
 */
export async function registerEvidence(client: Client, input: RegistrationInput): Promise<Registration> {
  const host = input.host ?? os.hostname();
  const target = resolveWorkspaceBackup(input.target.workspace, input.target);
  const sidecar = verifySidecar(target);
  const device = readDevice([target.decryptedPath, sidecar.sourcePath]);
  const key = deviceKey(device.udid, loadDeviceSecret(input.secretPath));
  const decryptedPath = target.decryptedPath;
  const derivatives = verifyDerivatives(
    decryptedPath,
    target.ileappOutputPath,
    target.crashReportsPath,
    sidecar.contentRoot
  );

  await client.query('BEGIN');
  try {
    // Evidence that's already registered keeps its device. Its identity is
    // its content; if the per-install secret was lost and regenerated, this
    // phone now hashes to a new device key, and re-registering the same
    // backup must still work rather than be refused or re-attributed.
    const known = await client.query<{ evidence_id: string; device_id: string }>(
      `SELECT evidence_id, device_id FROM evidence_items WHERE content_root = $1`,
      [sidecar.contentRoot]
    );
    let evidenceId: string;
    let deviceId: string;
    if (known.rows.length > 0) {
      ({ evidence_id: evidenceId, device_id: deviceId } = known.rows[0]);
    } else {
      // An existing device keeps its label: the user may have renamed it.
      const deviceRow = await client.query<{ device_id: string }>(
        `INSERT INTO devices (device_key, label) VALUES ($1, $2)
         ON CONFLICT (device_key) DO UPDATE SET device_key = EXCLUDED.device_key
         RETURNING device_id`,
        [key, device.name]
      );
      deviceId = deviceRow.rows[0].device_id;
      const created = await client.query<{ evidence_id: string }>(
        `INSERT INTO evidence_items (content_root, device_id, file_count, total_bytes)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (content_root) DO NOTHING
         RETURNING evidence_id`,
        [sidecar.contentRoot, deviceId, sidecar.fileCount, sidecar.totalBytes]
      );
      if (created.rows.length > 0) {
        evidenceId = created.rows[0].evidence_id;
        await appendEvent(client, evidenceId, 'registered', host, {
          content_root: sidecar.contentRoot,
          file_count: sidecar.fileCount,
          total_bytes: sidecar.totalBytes,
          hashed_at: sidecar.hashedAt,
        });
      } else {
        // Registered by a concurrent run between the SELECT and the INSERT.
        const raced = await client.query<{ evidence_id: string; device_id: string }>(
          `SELECT evidence_id, device_id FROM evidence_items WHERE content_root = $1`,
          [sidecar.contentRoot]
        );
        ({ evidence_id: evidenceId, device_id: deviceId } = raced.rows[0]);
      }
    }

    const location = await client.query<{ inserted: boolean }>(
      `INSERT INTO evidence_locations (evidence_id, host, path) VALUES ($1, $2, $3)
       ON CONFLICT (evidence_id, host, path) DO UPDATE SET last_seen_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [evidenceId, host, sidecar.sourcePath]
    );
    if (location.rows[0].inserted) {
      await appendEvent(client, evidenceId, 'location_added', host, { path: sidecar.sourcePath });
    }

    const decryptedDerivativeId = await upsertDerivative(
      client,
      evidenceId,
      'decrypted',
      decryptedPath,
      null,
      host,
      derivatives.decrypt
    );
    const ileappDerivativeId = derivatives.ileapp
      ? await upsertDerivative(
          client,
          evidenceId,
          'ileapp_output',
          derivatives.ileapp.path,
          decryptedDerivativeId,
          host,
          derivatives.ileapp.provenance
        )
      : null;
    // The device's crash logs belong to the same evidence, with no parent:
    // they were acquired in the same pull, not derived from the backup.
    const crashReportsDerivativeId = derivatives.crashReports
      ? await upsertDerivative(
          client,
          evidenceId,
          'crash_reports',
          derivatives.crashReports.path,
          null,
          host,
          derivatives.crashReports.provenance
        )
      : null;

    await client.query('COMMIT');
    return { evidenceId, deviceId, decryptedDerivativeId, ileappDerivativeId, crashReportsDerivativeId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
