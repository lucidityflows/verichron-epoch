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
 *      content_root), the location and the derivatives, appending an
 *      evidence_events row for each thing that is new.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Client } from 'pg';

import { deriveEvidencePath, EvidenceSidecar } from '@verichron/contracts';

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
  /** mvt-ios's results for that decrypt, when the results directory exists. */
  resultsDerivativeId: string | null;
}

export interface RegistrationInput {
  /** <workspace>/decrypted/<label>, as the orchestrator receives it. */
  backupPath: string;
  /** <workspace>/results/<label>, if derivable. */
  resultsPath?: string;
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
 */
export function loadDeviceSecret(secretPath: string = defaultSecretPath()): Buffer {
  if (!existsSync(secretPath)) {
    mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
    try {
      // 'wx' fails if another process created it first; then we just read it.
      writeFileSync(secretPath, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
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

const XML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

/**
 * Top-level <key>/<string> pairs of an XML property list. iTunes and
 * idevicebackup2 write Info.plist as XML; a binary plist is refused with a
 * clear message rather than guessed at.
 */
export function readPlistStrings(file: string): Map<string, string> {
  const bytes = readFileSync(file);
  if (bytes.subarray(0, 8).toString('latin1') === 'bplist00') {
    throw new RegistrationError(`${file} is a binary property list; only XML Info.plist is supported`);
  }
  const text = bytes.toString('utf8');
  const out = new Map<string, string>();
  for (const match of text.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (e) => XML_ENTITIES[e]);
    out.set(decode(match[1]), decode(match[2]));
  }
  return out;
}

function readDevice(candidates: string[]): { udid: string; name: string } {
  const plistPath = candidates.map((dir) => path.join(dir, 'Info.plist')).find((p) => existsSync(p));
  if (!plistPath) {
    throw new RegistrationError(`no Info.plist in ${candidates.join(' or ')}; cannot identify the device`);
  }
  const keys = readPlistStrings(plistPath);
  const udid = keys.get('Unique Identifier') || keys.get('Target Identifier');
  if (!udid) {
    throw new RegistrationError(`${plistPath} has no "Unique Identifier" or "Target Identifier"`);
  }
  return { udid, name: keys.get('Device Name') || keys.get('Display Name') || 'Unknown device' };
}

// ---------------------------------------------------------------------------
// Evidence files
// ---------------------------------------------------------------------------

/** <workspace>/decrypted/<label> -> { workspace, label }. */
export function locateWorkspace(backupPath: string): { workspace: string; label: string } {
  const resolved = path.resolve(backupPath);
  const parent = path.dirname(resolved);
  if (path.basename(parent) !== 'decrypted') {
    throw new RegistrationError(
      `${backupPath} is not under <workspace>/decrypted/<label>; cannot find its evidence sidecar`
    );
  }
  return { workspace: path.dirname(parent), label: path.basename(resolved) };
}

interface VerifiedSidecar {
  contentRoot: string;
  fileCount: number;
  totalBytes: number;
  sourcePath: string;
  hashedAt: string;
}

function verifySidecar(workspace: string, label: string): VerifiedSidecar {
  const paths = deriveEvidencePath(workspace, label);
  if (!existsSync(paths.sidecar)) {
    throw new RegistrationError(
      `no evidence sidecar at ${paths.sidecar}; re-run mvt-runner so the backup is hashed (EPOCH-401)`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.sidecar, 'utf8'));
  } catch (err) {
    throw new RegistrationError(`${paths.sidecar} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = EvidenceSidecar.safeParse(raw);
  if (!parsed.success) {
    throw new RegistrationError(`${paths.sidecar} does not match the evidence sidecar contract: ${parsed.error.message}`);
  }
  const sidecar = parsed.data;
  if (sidecar.evidence_name !== label) {
    throw new RegistrationError(
      `${paths.sidecar} describes "${sidecar.evidence_name}", not "${label}"`
    );
  }

  // The manifest must be the content-addressed one for this very root, inside
  // this label's evidence directory: no path tricks, no swapped files.
  const manifestPath = path.resolve(workspace, sidecar.manifest_path);
  if (manifestPath !== paths.manifestFor(sidecar.content_root)) {
    throw new RegistrationError(
      `${paths.sidecar} points its manifest at ${sidecar.manifest_path}, expected ` +
        path.relative(workspace, paths.manifestFor(sidecar.content_root))
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
  await client.query(
    `INSERT INTO evidence_events (evidence_id, kind, host, detail) VALUES ($1, $2, $3, $4)`,
    [evidenceId, kind, host, detail]
  );
}

async function upsertDerivative(
  client: Client,
  evidenceId: string,
  kind: 'decrypted' | 'mvt_results',
  derivativePath: string,
  parentId: string | null,
  host: string
): Promise<string> {
  const { rows } = await client.query<{ derivative_id: string; inserted: boolean }>(
    `INSERT INTO evidence_derivatives (evidence_id, kind, path, parent_derivative_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (evidence_id, kind, path) DO UPDATE SET path = EXCLUDED.path
     RETURNING derivative_id, (xmax = 0) AS inserted`,
    [evidenceId, kind, derivativePath, parentId]
  );
  if (rows[0].inserted) {
    await appendEvent(client, evidenceId, 'derivative_registered', host, {
      derivative_id: rows[0].derivative_id,
      kind,
      path: derivativePath,
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
  const { workspace, label } = locateWorkspace(input.backupPath);
  const sidecar = verifySidecar(workspace, label);
  const device = readDevice([path.resolve(input.backupPath), sidecar.sourcePath]);
  const key = deviceKey(device.udid, loadDeviceSecret(input.secretPath));
  const decryptedPath = path.resolve(input.backupPath);
  const resultsPath = input.resultsPath && existsSync(input.resultsPath) ? path.resolve(input.resultsPath) : null;

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

    const decryptedDerivativeId = await upsertDerivative(client, evidenceId, 'decrypted', decryptedPath, null, host);
    const resultsDerivativeId = resultsPath
      ? await upsertDerivative(client, evidenceId, 'mvt_results', resultsPath, decryptedDerivativeId, host)
      : null;

    await client.query('COMMIT');
    return { evidenceId, deviceId, decryptedDerivativeId, resultsDerivativeId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
