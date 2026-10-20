/**
 * EPOCH-404 against real Postgres (R33): pre-flight registration,
 * evidence-keyed resume, the canonical completeness predicate, and the
 * identity each stage is given. Each run creates a throwaway database, applies
 * the migrations, and drops it; workspaces are built on disk in a temp dir.
 *
 * Needs TEST_DATABASE_URL (a role that may CREATE DATABASE). Skipped locally
 * when unset; fails in CI. Run: pnpm --filter @verichron/orchestrator test
 */

import { safeTestDatabaseUrl } from '@verichron/contracts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import pg from 'pg';

import {
  DECRYPT_MARKER,
  ILEAPP_MARKER,
  CRASH_REPORTS_MARKER,
  PIPELINE_EVENT_PREFIX,
  createWorkspaceManifestBackup,
  emptyWorkspaceManifest,
  findWorkspaceBackupForPath,
  parsePipelineEventLine,
  type PipelineEvent,
  readWorkspaceManifestSync,
  renderCrashReportsMarker,
  renderDecryptMarker,
  renderIleappMarker,
  resolveRunSummaryPath,
  resolveWorkspaceBackup,
  type DecryptParams,
  type ResolvedWorkspaceBackup,
} from '@verichron/contracts';

import { createRun, getRunState, hasCompleteRunFor } from './db.js';
import { discoverStages } from './discovery.js';
import { STOPPED_EXIT_CODE, requestStop, resetStopForTests, runPipelineForBackup } from './pipeline.js';
import { readRunSummary } from './runSummary.js';
import { deviceKey, loadDeviceSecret, readPlistStrings, registerEvidence, RegistrationError } from './registration.js';
import { setOutputMode } from './events.js';
import type { StageDefinition, StageSet } from './types.js';

// Refused unless it names a test database: these tests empty the tables they use (EPOCH-570).
const DSN = safeTestDatabaseUrl();
const MIGRATIONS = path.resolve(import.meta.dirname, '../../../packages/etl-db-writer/migrations');
const UDID = '00008030-001A2B3C4D5E6F70';
const DECRYPT = { name: 'iphone_backup_decrypt', version: '0.10.0' };
const REPAIRED: DecryptParams = {
  repair: {
    status: 'ran',
    tool: { name: 'sqlite3', version: '3.45.1' },
    scanned: 12,
    repaired: 1,
    failed_files: [],
    preserved_originals: ['HomeDomain/Library/sms.db.corrupt-2026-10-08T00-00-00-000Z'],
  },
};
const ILEAPP = { name: 'iLEAPP', version: '24ba13daf37d8ef3c63c959768e31aae8e630c03' };

/** The markers the processor writes once each derivative is done (EPOCH-404, EPOCH-406). */
const decryptMarker = (root: string, params: DecryptParams = REPAIRED) => renderDecryptMarker(root, DECRYPT, params);
const ILEAPP_PARAMS = {
  input_type: 'itunes' as const,
  modules: { total: 0, complete: 0, no_files_found: [], errors: [] },
};
const ileappMarker = (root: string, tool = ILEAPP) => renderIleappMarker(root, tool, ILEAPP_PARAMS);

let admin: pg.Client;
let db: pg.Client;
let dbName: string;
let tmp: string;
let secretPath: string;

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'epoch404-'));
  secretPath = path.join(tmp, 'config', 'device-key.secret');
  if (!DSN) return;
  dbName = `orchestrator_test_${Date.now()}_${process.pid}`;
  admin = new pg.Client({ connectionString: DSN });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const url = new URL(DSN);
  url.pathname = `/${dbName}`;
  db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await db.query(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  }
});

after(async () => {
  if (DSN) {
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  }
  rmSync(tmp, { recursive: true, force: true });
});

const live = { skip: !DSN && !process.env.CI ? 'TEST_DATABASE_URL not set; needs real Postgres' : false };

it('has a database in CI', { skip: !process.env.CI }, () => {
  assert.ok(DSN, 'TEST_DATABASE_URL must be set in CI for the orchestrator tests');
});

beforeEach(async () => {
  if (!DSN) return;
  await db.query(`TRUNCATE forensic_records, ingested_files, pipeline_stage_status, pipeline_runs,
                  evidence_events, evidence_derivatives, evidence_locations, evidence_items, devices,
                  indicators, indicator_set_files, indicator_sets, indicator_file_contents CASCADE`);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Workspace {
  workspace: string;
  backupPath: string;
  ileappPath: string;
  sidecarPath: string;
  contentRoot: string;
  target: ResolvedWorkspaceBackup;
}

function infoPlist(udid: string, name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Device Name</key><string>${name}</string>
  <key>Unique Identifier</key><string>${udid}</string>
  <key>Product Type</key><string>iPhone17,5</string>
  <key>Product Version</key><string>26.6.1</string>
  <key>Last Backup Date</key><date>2026-10-15T18:05:25Z</date>
</dict></plist>`;
}

/** A workspace as the processor leaves it: decrypted backup, iLEAPP output, and the EPOCH-401 evidence files (content-addressed manifest + sidecar). */
function makeWorkspace(
  name: string,
  {
    manifest = 'a'.repeat(64) + '  Manifest.db\n',
    sourcePath = `/media/source/${name}`,
    label = 'BK1',
    ileapp = true,
  }: { manifest?: string; sourcePath?: string; label?: string; ileapp?: boolean } = {}
): Workspace {
  const workspace = path.join(tmp, name);
  const entry = createWorkspaceManifestBackup(label, sourcePath);
  const target = resolveWorkspaceBackup(workspace, entry);
  const backupPath = target.decryptedPath;
  const ileappPath = target.ileappOutputPath;
  mkdirSync(backupPath, { recursive: true });
  writeFileSync(path.join(backupPath, 'Manifest.db'), '');
  writeFileSync(path.join(backupPath, 'Info.plist'), infoPlist(UDID, 'Alice &amp; Bob&apos;s iPhone'));
  const contentRoot = createHash('sha256').update(manifest).digest('hex');
  // Provenance markers, as the processor writes them once each derivative is done.
  writeFileSync(path.join(backupPath, DECRYPT_MARKER), decryptMarker(contentRoot));
  if (ileapp) {
    mkdirSync(ileappPath, { recursive: true });
    writeFileSync(path.join(ileappPath, ILEAPP_MARKER), ileappMarker(contentRoot));
  }

  mkdirSync(target.manifestDirectory, { recursive: true });
  const evidenceManifestPath = path.join(target.manifestDirectory, `${contentRoot}.sha256`);
  writeFileSync(evidenceManifestPath, manifest);
  const sidecarPath = target.sidecarPath;
  writeFileSync(
    sidecarPath,
    JSON.stringify({
      schema_version: 1,
      evidence_name: label,
      algorithm: 'sha256',
      content_root: contentRoot,
      manifest_path: path.relative(workspace, evidenceManifestPath).split(path.sep).join('/'),
      file_count: 1,
      total_bytes: 0,
      source_path: target.sourcePath,
      hashed_at: '2026-10-08T00:00:00.000Z',
      tool: { name: 'processor', version: '0.1.0' },
    })
  );
  const workspaceManifestPath = path.join(workspace, 'workspace.json');
  const workspaceManifest = existsSync(workspaceManifestPath)
    ? readWorkspaceManifestSync(workspace)
    : emptyWorkspaceManifest();
  writeFileSync(
    workspaceManifestPath,
    JSON.stringify({
      ...workspaceManifest,
      backups: [...workspaceManifest.backups.filter((backup) => backup.label !== label), entry],
    })
  );
  return { workspace, backupPath, ileappPath, sidecarPath, contentRoot, target };
}

/** A node stage that records the arguments it was given. */
function recordingStage(
  name: string,
  order: number,
  manifest: Partial<StageDefinition['manifest']> = {}
): StageDefinition {
  const dir = path.join(tmp, 'stages', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'stage.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(path.join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));\n`
  );
  return {
    name,
    dir,
    manifest: { entrypoint: 'stage.mjs', runtime: 'node', order, reads: 'decrypted', enabled: true, ...manifest },
  };
}

function argsOf(stage: StageDefinition): Record<string, string> {
  const argv: string[] = JSON.parse(readFileSync(path.join(stage.dir, 'argv.json'), 'utf8'));
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i]] = argv[i + 1];
  return out;
}

const NO_STAGES: StageSet = { enabled: [], disabled: [] };
const run = async (backupPath: string, stages: StageSet = NO_STAGES) => {
  const target = await findWorkspaceBackupForPath(backupPath);
  if (!target) throw new Error(`no workspace manifest for ${backupPath}`);
  return runPipelineForBackup(db, target.entry, DSN ?? '', 'python3', stages, { secretPath });
};

/** A registered indicator set, as the registry stores one (EPOCH-490); `registeredAt` orders "newest". */
async function registerSet(name: string, registeredAt: string): Promise<{ setId: string; setHash: string }> {
  const manifest = `${JSON.stringify({ format: 1, files: [], name })}\n`;
  const setHash = createHash('sha256').update(manifest).digest('hex');
  const { rows } = await db.query<{ set_id: string }>(
    `INSERT INTO indicator_sets (set_hash, name, manifest, loaded_at, registered_at, indicator_count)
     VALUES ($1, $2, $3, $4, $4, 0) RETURNING set_id`,
    [setHash, name, manifest, registeredAt]
  );
  return { setId: rows[0].set_id, setHash };
}

async function count(table: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(rows[0].n);
}

// ---------------------------------------------------------------------------
// Pure pieces (no database)
// ---------------------------------------------------------------------------

describe('device identity', () => {
  it('creates a 0600 secret on first use and keys the device by HMAC, never the raw UDID', () => {
    const secret = loadDeviceSecret(secretPath);
    assert.equal(statSync(secretPath).mode & 0o777, 0o600);
    assert.deepEqual(loadDeviceSecret(secretPath), secret, 'the secret is stable once created');
    const key = deviceKey(UDID, secret);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!key.includes(UDID.toLowerCase()));
    assert.equal(deviceKey(` ${UDID.toLowerCase()} `, secret), key, 'UDID case and spacing do not split a device');
  });

  it('concurrent first use publishes one complete secret that every process reads', async () => {
    const shared = path.join(tmp, 'race', 'device-key.secret');
    const script = `import { loadDeviceSecret } from ${JSON.stringify(path.resolve(import.meta.dirname, 'registration.ts'))};
      process.stdout.write(loadDeviceSecret(${JSON.stringify(shared)}).toString('hex'));`;
    const run = promisify(execFile);
    const outputs = await Promise.all(
      Array.from({ length: 8 }, () =>
        run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: import.meta.dirname })
      )
    );
    const secrets = new Set(outputs.map((o) => o.stdout));
    assert.equal(secrets.size, 1, 'every racing process read the same secret');
    assert.match([...secrets][0], /^[0-9a-f]{64}$/);
    assert.deepEqual(readdirSync(path.dirname(shared)), ['device-key.secret'], 'no staging files left behind');
  });

  it('refuses a secret other users can read', { skip: process.platform === 'win32' }, () => {
    const loose = path.join(tmp, 'loose', 'device-key.secret');
    loadDeviceSecret(loose);
    chmodSync(loose, 0o644);
    assert.throws(() => loadDeviceSecret(loose), RegistrationError);
  });

  it('reads XML Info.plist strings and refuses a binary plist', () => {
    const xml = path.join(tmp, 'Info.plist');
    writeFileSync(xml, infoPlist(UDID, 'A &amp; B'));
    assert.equal(readPlistStrings(xml).get('Device Name'), 'A & B');
    const binary = path.join(tmp, 'binary.plist');
    writeFileSync(binary, Buffer.from('bplist00\u0000\u0001', 'latin1'));
    assert.throws(() => readPlistStrings(binary), /binary property list/);
  });
});

// ---------------------------------------------------------------------------
// Registration and resume (Postgres)
// ---------------------------------------------------------------------------

describe('pre-flight registration', live, () => {
  it('one backup at two mount paths is one evidence item with two locations, and resumes', async () => {
    const ws = makeWorkspace('remount', { sourcePath: '/media/usb-a/BK1' });
    const first = await run(ws.backupPath);
    assert.equal(first.success, true);
    assert.ok(first.runId, 'the first run is created');

    // Same backup, source now mounted somewhere else: same content_root.
    const sidecar = JSON.parse(readFileSync(ws.sidecarPath, 'utf8'));
    writeFileSync(ws.sidecarPath, JSON.stringify({ ...sidecar, source_path: '/media/usb-b/BK1' }));
    const workspaceManifest = JSON.parse(readFileSync(path.join(ws.workspace, 'workspace.json'), 'utf8'));
    workspaceManifest.backups[0].source_path = '/media/usb-b/BK1';
    writeFileSync(path.join(ws.workspace, 'workspace.json'), JSON.stringify(workspaceManifest));
    const second = await run(ws.backupPath);

    assert.equal(second.skipped, true, 'the evidence already has a complete run, so it is skipped');
    assert.equal(second.evidenceId, first.evidenceId);
    assert.equal(await count('evidence_items'), 1);
    assert.equal(await count('evidence_locations'), 2);
    assert.equal(await count('pipeline_runs'), 1, 'no second run for complete evidence');
    const events = await db.query<{ kind: string }>(`SELECT kind FROM evidence_events ORDER BY event_id`);
    assert.deepEqual(
      events.rows.map((e) => e.kind),
      ['registered', 'location_added', 'derivative_registered', 'derivative_registered', 'location_added']
    );
  });

  it('a workspace moved to another path keeps its derivatives and resumes', async () => {
    const ws = makeWorkspace('moving');
    const first = await run(ws.backupPath);
    assert.ok(first.runId);

    const moved = path.join(tmp, 'moved-elsewhere');
    cpSync(ws.workspace, moved, { recursive: true });
    const second = await run(path.join(moved, 'decrypted', 'BK1'));

    assert.equal(second.skipped, true, 'the completed run is found, not redone');
    const { rows } = await db.query<{ kind: string; path: string }>(
      `SELECT kind, path FROM evidence_derivatives ORDER BY kind`
    );
    assert.deepEqual(
      rows.map((r) => r.kind),
      ['decrypted', 'ileapp_output'],
      'the same derivatives, not new ones'
    );
    assert.ok(
      rows.every((r) => r.path.startsWith(moved)),
      'each derivative records its new location'
    );
  });

  it('every run row carries its evidence and derivative', async () => {
    const ws = makeWorkspace('stamped');
    const result = await run(ws.backupPath);
    const { rows } = await db.query(`SELECT evidence_id, derivative_id FROM pipeline_runs WHERE run_id = $1`, [
      result.runId,
    ]);
    assert.equal(rows[0].evidence_id, result.evidenceId);
    assert.ok(rows[0].derivative_id);
  });

  for (const [label, corrupt] of [
    ['a missing sidecar', (ws: Workspace) => rmSync(ws.sidecarPath)],
    ['a malformed sidecar', (ws: Workspace) => writeFileSync(ws.sidecarPath, '{"schema_version": 1}')],
    [
      'a sidecar whose manifest does not match its root',
      (ws: Workspace) => {
        const manifest = path.join(ws.target.manifestDirectory, `${ws.contentRoot}.sha256`);
        writeFileSync(manifest, 'tampered\n');
      },
    ],
    [
      'a sidecar pointing outside its evidence directory',
      (ws: Workspace) => {
        const sidecar = JSON.parse(readFileSync(ws.sidecarPath, 'utf8'));
        writeFileSync(ws.sidecarPath, JSON.stringify({ ...sidecar, manifest_path: '../../etc/passwd' }));
      },
    ],
  ] as const) {
    it(`${label} creates zero runs and registers nothing`, async () => {
      const ws = makeWorkspace(`bad-${label.replace(/\W+/g, '-')}`);
      corrupt(ws);
      const result = await run(ws.backupPath);
      assert.equal(result.success, false);
      assert.ok(result.error);
      assert.equal(await count('pipeline_runs'), 0);
      assert.equal(await count('evidence_items'), 0);
    });
  }

  for (const [label, corrupt] of [
    [
      'a decrypt made from an earlier version of the backup',
      (ws: Workspace) => writeFileSync(path.join(ws.backupPath, DECRYPT_MARKER), decryptMarker('f'.repeat(64))),
    ],
    ['a decrypt with no provenance marker', (ws: Workspace) => rmSync(path.join(ws.backupPath, DECRYPT_MARKER))],
    [
      'a decrypt marker without tool provenance (pre-EPOCH-406 format)',
      (ws: Workspace) =>
        writeFileSync(
          path.join(ws.backupPath, DECRYPT_MARKER),
          JSON.stringify({ content_root: ws.contentRoot, completed_at: '2026-10-08T00:00:00.000Z' })
        ),
    ],
    [
      'an iLEAPP output path that is a file, not a directory',
      (ws: Workspace) => {
        rmSync(ws.ileappPath, { recursive: true });
        writeFileSync(ws.ileappPath, 'not a directory');
      },
    ],
    [
      'iLEAPP output made from an earlier version of the backup',
      (ws: Workspace) => writeFileSync(path.join(ws.ileappPath, ILEAPP_MARKER), ileappMarker('f'.repeat(64))),
    ],
  ] as const) {
    it(`${label} is refused before any run`, async () => {
      const ws = makeWorkspace(`stale-${label.replace(/\W+/g, '-')}`);
      corrupt(ws);
      const result = await run(ws.backupPath);
      assert.equal(result.success, false);
      assert.ok(result.error);
      assert.equal(await count('pipeline_runs'), 0);
      assert.equal(await count('evidence_items'), 0);
    });
  }

  it('iLEAPP output whose run never finished is not registered, and stages reading it stop before starting', async () => {
    const ws = makeWorkspace('ileapp-unfinished');
    rmSync(path.join(ws.ileappPath, ILEAPP_MARKER));
    const reader = recordingStage('needs-ileapp', 10, { reads: 'ileapp_output', parserVersion: 1 });
    const result = await run(ws.backupPath, { enabled: [reader], disabled: [] });
    assert.equal(result.success, false);
    const kinds = await db.query<{ kind: string }>(`SELECT kind FROM evidence_derivatives ORDER BY kind`);
    assert.deepEqual(
      kinds.rows.map((r) => r.kind),
      ['decrypted']
    );
    const stage = await db.query(`SELECT status, error_message FROM pipeline_stage_status WHERE run_id = $1`, [
      result.runId,
    ]);
    assert.equal(stage.rows[0].status, 'failed');
    assert.match(stage.rows[0].error_message, /reads iLEAPP output, but none is registered for this backup/);
  });

  it('stores no raw UDID anywhere', async () => {
    const ws = makeWorkspace('no-udid');
    await run(ws.backupPath);
    const { rows } = await db.query(`SELECT d.*, e.* FROM devices d JOIN evidence_items e USING (device_id)`);
    assert.ok(!JSON.stringify(rows).toUpperCase().includes(UDID), 'the UDID never reaches the database');
    assert.equal(rows[0].device_key, deviceKey(UDID, loadDeviceSecret(secretPath)));
    assert.equal(rows[0].label, "Alice & Bob's iPhone");
  });

  it('known evidence keeps its device even if the device key changes', async () => {
    const ws = makeWorkspace('rekeyed');
    const first = await run(ws.backupPath);
    // Force a re-run: an unfinished run has no end reason (migration 0017).
    await db.query(`UPDATE pipeline_runs SET finished_at = NULL, ended_reason = NULL`);
    rmSync(secretPath); // a lost per-install secret: new key for the same phone
    const second = await run(ws.backupPath);
    assert.equal(second.evidenceId, first.evidenceId);
    assert.equal(await count('evidence_items'), 1);
  });
});

describe('stages and the completeness predicate', live, () => {
  it('passes each stage its evidence, the derivative it reads (id and path), its parser version and its name', async () => {
    const ws = makeWorkspace('args');
    const reader = recordingStage('reader', 10, { parserVersion: 3 });
    const ileappReader = recordingStage('ileapp-reader', 30, { parserVersion: 1, reads: 'ileapp_output' });
    const report = recordingStage('report', 1000);
    const result = await run(ws.backupPath, { enabled: [reader, ileappReader, report], disabled: [] });
    assert.equal(result.success, true, JSON.stringify(result));

    const { rows } = await db.query<{ kind: string; derivative_id: string }>(
      `SELECT kind, derivative_id FROM evidence_derivatives WHERE evidence_id = $1`,
      [result.evidenceId]
    );
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.derivative_id]));

    assert.equal(argsOf(reader)['--evidence-id'], result.evidenceId);
    assert.equal(argsOf(reader)['--derivative-id'], byKind.decrypted);
    assert.equal(argsOf(reader)['--parser-version'], '3');
    assert.equal(argsOf(ileappReader)['--derivative-id'], byKind.ileapp_output, 'iLEAPP stages read the iLEAPP output');
    assert.equal(argsOf(reader)['--derivative-path'], ws.backupPath);
    assert.equal(argsOf(ileappReader)['--derivative-path'], ws.ileappPath);
    assert.equal(argsOf(report)['--parser-version'], undefined, 'a stage that declares none is passed none');
    assert.equal(argsOf(reader)['--stage-name'], 'reader', 'a stage that writes facts labels its failures');
    assert.equal(argsOf(report)['--stage-name'], undefined);
    assert.equal(
      argsOf(report)['--report-path'],
      path.join(ws.workspace, 'reports', 'BK1'),
      'every stage is told where the report goes'
    );
  });

  it('records disabled stages as skipped, and skipped never makes a run incomplete', async () => {
    const ws = makeWorkspace('skips');
    const disabled = recordingStage('stub', 30, { enabled: false });
    const result = await run(ws.backupPath, { enabled: [], disabled: [disabled] });
    const { rows } = await db.query(`SELECT stage_name, status FROM pipeline_stage_status WHERE run_id = $1`, [
      result.runId,
    ]);
    assert.deepEqual(rows, [{ stage_name: 'stub', status: 'skipped' }]);
    assert.equal(await getRunState(db, result.runId!), 'complete');
  });

  it('crash logs the pull acquired are registered with the evidence and passed to the stage reading them (EPOCH-514)', async () => {
    const ws = makeWorkspace('with-crash-logs');
    const crashPath = path.join(ws.workspace, 'crash_reports', 'BK1');
    mkdirSync(crashPath, { recursive: true });
    const params = {
      acquired_at: '2026-10-15T01:00:00.000Z',
      backup_finished_at: '2026-10-15T00:59:30.000Z',
      files: 230,
      bytes: 7_600_000,
      reports_root: 'c'.repeat(64),
    };
    writeFileSync(
      path.join(crashPath, CRASH_REPORTS_MARKER),
      renderCrashReportsMarker(ws.contentRoot, { name: 'idevicecrashreport', version: '1.4.0' }, params)
    );
    const crash = recordingStage('crash-logs-reader', 10, { reads: 'crash_reports', parserVersion: 2 });
    const result = await run(ws.backupPath, { enabled: [crash], disabled: [] });
    assert.equal(result.success, true, JSON.stringify(result));

    const { rows } = await db.query(
      `SELECT derivative_id, parent_derivative_id, tool, params, path FROM evidence_derivatives
        WHERE evidence_id = $1 AND kind = 'crash_reports'`,
      [result.evidenceId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].parent_derivative_id, null, 'acquired with the backup, not made from it');
    assert.deepEqual(rows[0].tool, { name: 'idevicecrashreport', version: '1.4.0' });
    assert.deepEqual(rows[0].params, params);
    assert.equal(argsOf(crash)['--derivative-id'], rows[0].derivative_id);
    assert.equal(argsOf(crash)['--derivative-path'], crashPath);

    // Copied again later: the same reports are the same derivative.
    writeFileSync(
      path.join(crashPath, CRASH_REPORTS_MARKER),
      renderCrashReportsMarker(
        ws.contentRoot,
        { name: 'idevicecrashreport', version: '1.4.0' },
        { ...params, acquired_at: '2026-10-16T09:00:00.000Z' }
      )
    );
    const again = await run(ws.backupPath, { enabled: [crash], disabled: [] });
    assert.equal(again.skipped, true, 'the same crash logs: the complete run stands');
  });

  it('crash logs whose marker names other evidence are refused before any run', async () => {
    const ws = makeWorkspace('foreign-crash-logs');
    const crashPath = path.join(ws.workspace, 'crash_reports', 'BK1');
    mkdirSync(crashPath, { recursive: true });
    writeFileSync(
      path.join(crashPath, CRASH_REPORTS_MARKER),
      renderCrashReportsMarker(
        'f'.repeat(64),
        { name: 'idevicecrashreport', version: '1.4.0' },
        {
          acquired_at: '2026-10-15T01:00:00.000Z',
          backup_finished_at: '2026-10-15T00:59:30.000Z',
          files: 0,
          bytes: 0,
          reports_root: 'c'.repeat(64),
        }
      )
    );
    const result = await run(ws.backupPath);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /the crash-log copy at .* was made from content root ffffffffffff/);
    assert.equal(await count('pipeline_runs'), 0);
  });

  it('a stage reading crash logs this evidence lacks is skipped with the reason, never run, and the run is complete (EPOCH-447)', async () => {
    const ws = makeWorkspace('no-crash-logs');
    const crash = recordingStage('crash-reader', 10, { reads: 'crash_reports', parserVersion: 1 });
    const result = await run(ws.backupPath, { enabled: [crash], disabled: [] });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(!existsSync(path.join(crash.dir, 'argv.json')), 'a stage with no input is never spawned');

    const { rows } = await db.query(
      `SELECT status, error_message, derivative_id, finished_at IS NOT NULL AS finished
         FROM pipeline_stage_status WHERE run_id = $1`,
      [result.runId]
    );
    assert.equal(rows[0].status, 'skipped');
    assert.match(rows[0].error_message, /Crash logs were not acquired for this evidence/);
    assert.match(rows[0].error_message, /An iOS backup does not contain the device's crash logs/);
    assert.equal(rows[0].derivative_id, null);
    assert.equal(rows[0].finished, true);
    assert.equal(await getRunState(db, result.runId!), 'complete');

    const again = await run(ws.backupPath, { enabled: [crash], disabled: [] });
    assert.equal(again.skipped, true, 'still no crash logs, so the complete run stands');
  });

  it('a stage checking an indicator set is skipped with the reason until one is registered, then checks the newest; a newer set gets a new run (EPOCH-491)', async () => {
    const ws = makeWorkspace('indicator-sets');
    const matcher = recordingStage('matcher', 500, { reads: 'indicator_set', parserVersion: 1 });
    const stages = { enabled: [matcher], disabled: [] };

    const none = await run(ws.backupPath, stages);
    assert.equal(none.success, true, JSON.stringify(none));
    assert.ok(!existsSync(path.join(matcher.dir, 'argv.json')), 'with no set, the stage is never spawned');
    const skipped = await db.query(
      `SELECT status, error_message, indicator_set_id FROM pipeline_stage_status WHERE run_id = $1`,
      [none.runId]
    );
    assert.equal(skipped.rows[0].status, 'skipped');
    assert.match(skipped.rows[0].error_message, /No indicator set is registered/);
    assert.equal(skipped.rows[0].indicator_set_id, null);
    assert.equal((await run(ws.backupPath, stages)).skipped, true, 'still no set, so the complete run stands');

    const older = await registerSet('older', '2026-10-01T00:00:00Z');
    const first = await run(ws.backupPath, stages);
    assert.notEqual(first.skipped, true, 'a set registered since gets a new run');
    assert.equal(argsOf(matcher)['--indicator-set-id'], older.setId);
    assert.equal(argsOf(matcher)['--derivative-id'], undefined, 'it reads no derivative');
    const row = await db.query(`SELECT indicator_set_id, derivative_id FROM pipeline_stage_status WHERE run_id = $1`, [
      first.runId,
    ]);
    assert.deepEqual(row.rows[0], { indicator_set_id: older.setId, derivative_id: null });
    assert.equal((await run(ws.backupPath, stages)).skipped, true, 'the same set: already done');

    const newer = await registerSet('newer', '2026-10-15T00:00:00Z');
    const second = await run(ws.backupPath, stages);
    assert.notEqual(second.skipped, true, 'a newer set gets a new run');
    assert.equal(argsOf(matcher)['--indicator-set-id'], newer.setId);
  });

  it('--indicator-set chooses a set by its hash, and an unknown hash fails before any run (EPOCH-491)', async () => {
    const ws = makeWorkspace('indicator-set-by-hash');
    const matcher = recordingStage('matcher', 500, { reads: 'indicator_set', parserVersion: 1 });
    const stages = { enabled: [matcher], disabled: [] };
    const older = await registerSet('older', '2026-10-01T00:00:00Z');
    await registerSet('newer', '2026-10-15T00:00:00Z');

    const chosen = await runPipelineForBackup(db, ws.target, DSN ?? '', 'python3', stages, {
      secretPath,
      indicatorSetHash: older.setHash,
    });
    assert.equal(chosen.success, true, JSON.stringify(chosen));
    assert.equal(argsOf(matcher)['--indicator-set-id'], older.setId);

    const runs = await count('pipeline_runs');
    const unknown = await runPipelineForBackup(db, ws.target, DSN ?? '', 'python3', stages, {
      secretPath,
      indicatorSetHash: 'f'.repeat(64),
    });
    assert.equal(unknown.success, false);
    assert.match(unknown.error ?? '', /no indicator set with hash/);
    assert.equal(await count('pipeline_runs'), runs, 'no run was created');
  });

  it('records the zone the report shows times in, and a new zone is not a reason to analyze again (EPOCH-560)', async () => {
    const ws = makeWorkspace('display-zone');
    const stage = recordingStage('zoned', 10);
    const stages = { enabled: [stage], disabled: [] };
    const zoned = await runPipelineForBackup(db, ws.target, DSN ?? '', 'python3', stages, {
      secretPath,
      displayZone: 'Asia/Kolkata',
    });
    assert.equal(zoned.success, true, JSON.stringify(zoned));
    const { rows } = await db.query(`SELECT display_zone FROM pipeline_runs WHERE run_id = $1`, [zoned.runId]);
    assert.deepEqual(rows, [{ display_zone: 'Asia/Kolkata' }]);

    const again = await runPipelineForBackup(db, ws.target, DSN ?? '', 'python3', stages, {
      secretPath,
      displayZone: 'America/Chicago',
    });
    assert.equal(again.skipped, true, 'the analysis is complete in any zone');

    const fresh = makeWorkspace('display-zone-default', { manifest: 'b'.repeat(64) + '  Manifest.db\n' });
    const utc = await runPipelineForBackup(db, fresh.target, DSN ?? '', 'python3', stages, { secretPath });
    const recorded = await db.query(`SELECT display_zone FROM pipeline_runs WHERE run_id = $1`, [utc.runId]);
    assert.deepEqual(recorded.rows, [{ display_zone: 'UTC' }], 'UTC when none is given');
  });

  it('refuses a zone that is not UTC or a named zone before any run is created (EPOCH-560)', async () => {
    const ws = makeWorkspace('display-zone-refused');
    const runs = await count('pipeline_runs');
    await assert.rejects(
      runPipelineForBackup(db, ws.target, DSN ?? '', 'python3', NO_STAGES, { secretPath, displayZone: 'CST' }),
      /"CST" is not a time zone Epoch can show times in/
    );
    assert.equal(await count('pipeline_runs'), runs, 'no run was created');
  });

  it("records each stage's declared order, so a run's stages read back in stage.json order, disabled ones in place (EPOCH-414)", async () => {
    const ws = makeWorkspace('stage-order');
    const registration = await registerEvidence(db, {
      target: ws.target,
      secretPath,
    });
    const provenance = { contractVersion: 'test', toolVersions: {}, displayZone: 'UTC' };

    // The real stages, as discovery finds them.
    const discovered = await discoverStages();
    const realRun = await createRun(db, ws.backupPath, discovered, provenance, registration);
    const real = await db.query<{ stage_name: string; stage_order: number }>(
      `SELECT stage_name, stage_order FROM pipeline_stage_status WHERE run_id = $1 ORDER BY stage_order, stage_name`,
      [realRun]
    );
    assert.deepEqual(
      real.rows.map((r) => [r.stage_name, r.stage_order]),
      [...discovered.enabled, ...discovered.disabled]
        .map((s) => [s.name, s.manifest.order])
        .sort((a, b) => Number(a[1]) - Number(b[1]))
    );
    assert.deepEqual(
      real.rows.map((r) => r.stage_name),
      ['crash', 'ileapp_bridge', 'indicator_match', 'reporting']
    );

    // A disabled stage keeps its declared place, recorded as skipped.
    const first = recordingStage('first', 10);
    const off = recordingStage('off', 15, { enabled: false });
    const last = recordingStage('last', 20);
    const mixedRun = await createRun(
      db,
      ws.backupPath,
      { enabled: [last, first], disabled: [off] },
      provenance,
      registration
    );
    const mixed = await db.query<{ stage_name: string; status: string }>(
      `SELECT stage_name, status FROM pipeline_stage_status WHERE run_id = $1 ORDER BY stage_order, stage_name`,
      [mixedRun]
    );
    assert.deepEqual(
      mixed.rows.map((r) => [r.stage_name, r.status]),
      [
        ['first', 'pending'],
        ['off', 'skipped'],
        ['last', 'pending'],
      ]
    );
  });

  it("a disabled stage's skip never stands in for an absent input: enabling it gets a new run", async () => {
    const ws = makeWorkspace('disabled-then-no-input');
    rmSync(path.join(ws.ileappPath, ILEAPP_MARKER)); // no iLEAPP output is registered
    const off = recordingStage('ileapp-reader', 10, { reads: 'ileapp_output', parserVersion: 1, enabled: false });
    const first = await run(ws.backupPath, { enabled: [], disabled: [off] });
    assert.equal(await getRunState(db, first.runId!), 'complete');

    const on = recordingStage('ileapp-reader', 10, { reads: 'ileapp_output', parserVersion: 1 });
    const second = await run(ws.backupPath, { enabled: [on], disabled: [] });
    assert.notEqual(second.skipped, true, 'the disabled skip must not hide the missing iLEAPP output');
    assert.equal(second.success, false, 'the stage fails on its missing input, as it should');
  });

  it('a finished run with a stage stuck pending or running is incomplete, not succeeded', async () => {
    const ws = makeWorkspace('killed');
    const result = await run(ws.backupPath, { enabled: [recordingStage('ok', 10)], disabled: [] });
    const derivative = await db.query(`SELECT derivative_id FROM pipeline_runs WHERE run_id = $1`, [result.runId]);
    for (const stuck of ['pending', 'running']) {
      await db.query(`UPDATE pipeline_stage_status SET status = $1 WHERE run_id = $2`, [stuck, result.runId]);
      assert.equal(await getRunState(db, result.runId!), 'incomplete', `a stage left ${stuck} by a killed process`);
      const registration = {
        evidenceId: result.evidenceId!,
        decryptedDerivativeId: derivative.rows[0].derivative_id,
        ileappDerivativeId: null,
        crashReportsDerivativeId: null,
      };
      assert.equal(await hasCompleteRunFor(db, registration, []), false);
    }
  });

  it("records each stage's declared parser version on the run", async () => {
    const ws = makeWorkspace('stage-versions');
    const versioned = recordingStage('versioned', 10, { parserVersion: 4 });
    const unversioned = recordingStage('unversioned', 20);
    const off = recordingStage('off', 30, { parserVersion: 2, enabled: false });
    const result = await run(ws.backupPath, { enabled: [versioned, unversioned], disabled: [off] });
    const { rows } = await db.query(
      `SELECT stage_name, parser_version FROM pipeline_stage_status WHERE run_id = $1 ORDER BY stage_name`,
      [result.runId]
    );
    assert.deepEqual(rows, [
      { stage_name: 'off', parser_version: 2 },
      { stage_name: 'unversioned', parser_version: null },
      { stage_name: 'versioned', parser_version: 4 },
    ]);
  });

  it('a parserVersion bump re-runs complete evidence; the same version does not', async () => {
    const ws = makeWorkspace('version-bump');
    const v1 = recordingStage('parser', 10, { parserVersion: 1 });
    const first = await run(ws.backupPath, { enabled: [v1], disabled: [] });
    assert.equal(await getRunState(db, first.runId!), 'complete');

    const same = await run(ws.backupPath, { enabled: [v1], disabled: [] });
    assert.equal(same.skipped, true, 'nothing changed, so the complete run stands');

    const v2 = recordingStage('parser', 10, { parserVersion: 2 });
    const bumped = await run(ws.backupPath, { enabled: [v2], disabled: [] });
    assert.notEqual(bumped.skipped, true, 'R8: a new parser version must reach the stage');
    assert.notEqual(bumped.runId, first.runId);
    assert.equal(argsOf(v2)['--parser-version'], '2');

    const again = await run(ws.backupPath, { enabled: [v2], disabled: [] });
    assert.equal(again.skipped, true, 'once version 2 has run, it is done');
  });

  it('a stage enabled after a complete run gets a new run', async () => {
    const ws = makeWorkspace('newly-enabled');
    const base = recordingStage('base', 10, { parserVersion: 1 });
    const later = recordingStage('later', 20, { parserVersion: 1, enabled: false });
    const first = await run(ws.backupPath, { enabled: [base], disabled: [later] });
    assert.equal(await getRunState(db, first.runId!), 'complete');

    const enabledLater = recordingStage('later', 20, { parserVersion: 1 });
    const second = await run(ws.backupPath, { enabled: [base, enabledLater], disabled: [] });
    assert.notEqual(second.skipped, true, 'the stage skipped as disabled never ran');
    assert.equal(argsOf(enabledLater)['--evidence-id'], first.evidenceId);

    const disabledAgain = await run(ws.backupPath, { enabled: [base], disabled: [later] });
    assert.equal(disabledAgain.skipped, true, 'disabling a stage again needs no new run');
  });

  it('refuses a backup identified only by GUID, which is not the device UDID', async () => {
    const ws = makeWorkspace('guid-only');
    writeFileSync(
      path.join(ws.backupPath, 'Info.plist'),
      infoPlist(UDID, 'Phone').replace('<key>Unique Identifier</key>', '<key>GUID</key>')
    );
    const result = await run(ws.backupPath);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /"GUID" is the backup's iTunes GUID, not the device UDID/);
    assert.equal(await count('evidence_items'), 0);
    assert.equal(await count('pipeline_runs'), 0);
  });

  it('records the model, iOS version and backup date that name the investigation (EPOCH-555)', async () => {
    const ws = makeWorkspace('described');
    const result = await run(ws.backupPath);
    assert.equal(result.success, true, result.error);
    const { rows } = await db.query(
      `SELECT product_type, ios_version,
              to_char(backup_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS backup_date
         FROM evidence_items`
    );
    assert.deepEqual(rows, [
      { product_type: 'iPhone17,5', ios_version: '26.6.1', backup_date: '2026-10-15T18:05:25Z' },
    ]);
  });

  it('refuses a backup whose Info.plist does not say its model', async () => {
    const ws = makeWorkspace('no-model');
    writeFileSync(
      path.join(ws.backupPath, 'Info.plist'),
      infoPlist(UDID, 'Phone').replace('<key>Product Type</key><string>iPhone17,5</string>', '')
    );
    const result = await run(ws.backupPath);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /has no "Product Type"; cannot name the investigation/);
    assert.equal(await count('evidence_items'), 0);
  });

  it('refuses a backup date with no UTC offset, which would be a guessed time (R11)', async () => {
    const ws = makeWorkspace('zoneless-date');
    writeFileSync(
      path.join(ws.backupPath, 'Info.plist'),
      infoPlist(UDID, 'Phone').replace('2026-10-15T18:05:25Z', '2026-10-15T18:05:25')
    );
    const result = await run(ws.backupPath);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /"Last Backup Date" that is not an ISO 8601 time with its offset/);
    assert.equal(await count('evidence_items'), 0);
  });

  it("records each derivative's tool, parameters and provenance key", async () => {
    const ws = makeWorkspace('provenance');
    await run(ws.backupPath);
    const { rows } = await db.query(
      `SELECT kind, tool, params, provenance_key FROM evidence_derivatives ORDER BY kind`
    );
    assert.deepEqual(
      rows.map((r) => [r.kind, r.tool]),
      [
        ['decrypted', DECRYPT],
        ['ileapp_output', ILEAPP],
      ]
    );
    assert.deepEqual(rows[0].params, REPAIRED, 'repair counts, failed files and preserved originals are queryable');
    assert.deepEqual(rows[1].params, ILEAPP_PARAMS);
    for (const r of rows) assert.match(r.provenance_key, /^[0-9a-f]{64}$/);
    const events = await db.query(
      `SELECT detail FROM evidence_events WHERE kind = 'derivative_registered' ORDER BY event_id`
    );
    assert.deepEqual(
      events.rows.map((e) => e.detail.tool),
      [DECRYPT, ILEAPP]
    );
  });

  it('registers iLEAPP output as a derivative of the decrypt it was made from', async () => {
    const ws = makeWorkspace('ileapp-parent');
    await run(ws.backupPath);
    const { rows } = await db.query(
      `SELECT o.path, o.parent_derivative_id = d.derivative_id AS from_decrypt, o.evidence_id = d.evidence_id AS same_evidence
         FROM evidence_derivatives o JOIN evidence_derivatives d ON d.kind = 'decrypted'
        WHERE o.kind = 'ileapp_output'`
    );
    assert.deepEqual(rows, [{ path: ws.ileappPath, from_decrypt: true, same_evidence: true }]);
  });

  it('iLEAPP output from a new iLEAPP commit is a new derivative, and stages reading it run again', async () => {
    const ws = makeWorkspace('new-ileapp');
    const reader = recordingStage('ileapp-reader', 10, { reads: 'ileapp_output', parserVersion: 1 });
    const first = await run(ws.backupPath, { enabled: [reader], disabled: [] });
    assert.equal(await getRunState(db, first.runId!), 'complete');
    const firstOutput = argsOf(reader)['--derivative-id'];

    const newer = { name: 'iLEAPP', version: 'c'.repeat(40) };
    writeFileSync(path.join(ws.ileappPath, ILEAPP_MARKER), ileappMarker(ws.contentRoot, newer));
    const second = await run(ws.backupPath, { enabled: [reader], disabled: [] });
    assert.notEqual(second.skipped, true, 'the new output has not been read');
    assert.notEqual(argsOf(reader)['--derivative-id'], firstOutput);

    const { rows } = await db.query(
      `SELECT derivative_id, tool FROM evidence_derivatives WHERE kind = 'ileapp_output' ORDER BY created_at`
    );
    assert.deepEqual(
      rows.map((r) => r.tool),
      [ILEAPP, newer],
      'the old output keeps its own row and provenance'
    );
    assert.equal(rows[0].derivative_id, firstOutput);
  });

  it('a repeated decrypt with the same repair outcome is the same derivative; only when originals were preserved changes (EPOCH-517)', async () => {
    const ws = makeWorkspace('re-decrypted');
    const first = await run(ws.backupPath);
    const later: DecryptParams = {
      repair: {
        ...(REPAIRED.repair as Extract<DecryptParams['repair'], { status: 'ran' }>),
        preserved_originals: ['HomeDomain/Library/sms.db.corrupt-2026-10-15T00-24-33-652Z'],
      },
    };
    writeFileSync(path.join(ws.backupPath, DECRYPT_MARKER), decryptMarker(ws.contentRoot, later));
    const second = await run(ws.backupPath);
    assert.equal(second.skipped, true, 'the same decrypt and iLEAPP output: the complete run stands');
    const { rows } = await db.query(`SELECT kind, params FROM evidence_derivatives ORDER BY kind`);
    assert.deepEqual(
      rows.map((r) => r.kind),
      ['decrypted', 'ileapp_output'],
      'no second decrypt, and no second iLEAPP output under it'
    );
    assert.deepEqual(rows[0].params, later, 'the row names the preserved originals that exist now');
    assert.equal(second.evidenceId, first.evidenceId);
  });

  it('a decrypt with a different repair outcome is a new derivative, never an update in place', async () => {
    const ws = makeWorkspace('re-repaired');
    await run(ws.backupPath);
    const unrepaired: DecryptParams = { repair: { status: 'skipped', reason: 'sqlite3 not available (sqlite3)' } };
    writeFileSync(path.join(ws.backupPath, DECRYPT_MARKER), decryptMarker(ws.contentRoot, unrepaired));
    rmSync(ws.ileappPath, { recursive: true });
    const second = await run(ws.backupPath);
    assert.notEqual(second.skipped, true, 'a new decrypt is new input');
    const { rows } = await db.query(
      `SELECT params FROM evidence_derivatives WHERE kind = 'decrypted' ORDER BY created_at`
    );
    assert.deepEqual(
      rows.map((r) => r.params),
      [REPAIRED, unrepaired]
    );
  });

  it('a failed stage makes the run incomplete, so the next invocation re-runs it', async () => {
    const ws = makeWorkspace('failing');
    const failing = recordingStage('fails', 10);
    writeFileSync(path.join(failing.dir, 'stage.mjs'), 'process.exit(3);\n');
    const first = await run(ws.backupPath, { enabled: [failing], disabled: [] });
    assert.equal(first.success, false);
    assert.equal(await getRunState(db, first.runId!), 'incomplete');
    const second = await run(ws.backupPath, { enabled: [failing], disabled: [] });
    assert.notEqual(second.skipped, true);
    assert.notEqual(second.runId, first.runId, 'a new run (D5), not a reopened one');
  });
});

describe('stage warnings (EPOCH-420)', live, () => {
  /** A stage that succeeds, printing `stderr` the way a Python stage prints its notes. */
  function notingStage(name: string, order: number, stderr: string): StageDefinition {
    const dir = path.join(tmp, 'stages', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'stage.mjs'), `process.stderr.write(${JSON.stringify(stderr)});\n`);
    return {
      name,
      dir,
      manifest: { entrypoint: 'stage.mjs', runtime: 'node', order, reads: 'decrypted', enabled: true },
    };
  }

  it('keeps what a succeeded stage printed as its warnings, never as an error, and the run stays complete', async () => {
    const ws = makeWorkspace('warnings', { label: 'A' });
    const notes = '[ileapp]   Calendar Events: 57 time(s) fall before 2007-06-29\n';
    const result = await run(ws.backupPath, {
      enabled: [notingStage('noted', 10, notes), recordingStage('quiet', 20)],
      disabled: [],
    });
    assert.equal(result.success, true);
    const { rows } = await db.query(
      `SELECT stage_name, status, warnings, error_message FROM pipeline_stage_status WHERE run_id = $1 ORDER BY stage_name`,
      [result.runId]
    );
    assert.deepEqual(rows, [
      { stage_name: 'noted', status: 'succeeded', warnings: notes.trim(), error_message: null },
      { stage_name: 'quiet', status: 'succeeded', warnings: null, error_message: null },
    ]);
    const { rows: state } = await db.query(`SELECT state FROM run_completeness WHERE run_id = $1`, [result.runId]);
    assert.equal(state[0].state, 'complete', 'warnings never change the verdict');
  });
});

describe('per-run summaries (EPOCH-409)', live, () => {
  const summaryOf = (target: ResolvedWorkspaceBackup, runId: string) => resolveRunSummaryPath(target, runId);

  it('a complete run whose summary went missing gets it back when the backup is skipped', async () => {
    const ws = makeWorkspace('summary-repair', { label: 'A' });
    const stages = { enabled: [recordingStage('ok', 10)], disabled: [] };
    const first = await run(ws.backupPath, stages);
    const file = summaryOf(ws.target, first.runId!);
    // What a failed export after the run was marked complete leaves behind.
    rmSync(file);

    const again = await run(ws.backupPath, stages);
    assert.equal(again.skipped, true);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), await readRunSummary(db, first.runId!));
  });

  it("writes each run's summary to its own file, as the database records it", async () => {
    const ws = makeWorkspace('summary-db', { label: 'A' });
    const result = await run(ws.backupPath, { enabled: [recordingStage('ok', 10)], disabled: [] });
    const file = summaryOf(ws.target, result.runId!);
    assert.equal(file, path.join(ws.workspace, 'runs', 'A', `${result.runId}.json`));
    const written = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(written, await readRunSummary(db, result.runId!));
    assert.equal(written.state, 'complete');
    assert.deepEqual(
      written.stages.map((s: { stage_name: string; status: string }) => [s.stage_name, s.status]),
      [['ok', 'succeeded']]
    );
  });

  it("running another backup in the same workspace leaves the first run's summary byte-identical", async () => {
    const a = makeWorkspace('summary-shared', { label: 'A' });
    const b = makeWorkspace('summary-shared', { label: 'B', manifest: 'b'.repeat(64) + '  Manifest.db\n' });
    const stages = { enabled: [recordingStage('ok', 10)], disabled: [] };
    const first = await run(a.backupPath, stages);
    const before = readFileSync(summaryOf(a.target, first.runId!));

    const other = await run(b.backupPath, stages);
    assert.notEqual(other.runId, first.runId);
    assert.ok(readFileSync(summaryOf(b.target, other.runId!)).length > 0);
    assert.deepEqual(readFileSync(summaryOf(a.target, first.runId!)), before);
  });

  it('a failed run writes its summary too, incomplete, and a rerun gets a file of its own', async () => {
    const ws = makeWorkspace('summary-failed', { label: 'A' });
    const failing = recordingStage('fails', 10);
    writeFileSync(path.join(failing.dir, 'stage.mjs'), 'process.exit(3);\n');
    const first = await run(ws.backupPath, { enabled: [failing], disabled: [] });
    const firstFile = summaryOf(ws.target, first.runId!);
    const before = readFileSync(firstFile);
    assert.equal(JSON.parse(before.toString()).state, 'incomplete');

    const second = await run(ws.backupPath, { enabled: [failing], disabled: [] });
    assert.ok(readFileSync(summaryOf(ws.target, second.runId!)).length > 0);
    assert.deepEqual(readFileSync(firstFile), before, 'the earlier run keeps its own summary');
    assert.deepEqual(
      readdirSync(path.join(ws.workspace, 'runs', 'A')).sort(),
      [`${first.runId}.json`, `${second.runId}.json`].sort()
    );
  });
});

describe('registration in isolation', live, () => {
  it('is all-or-nothing: a refusal mid-transaction leaves nothing behind', async () => {
    const ws = makeWorkspace('atomic', { ileapp: false });
    // Make the derivative insert fail inside the transaction.
    await db.query(`ALTER TABLE evidence_derivatives ADD CONSTRAINT test_block CHECK (path <> '${ws.backupPath}')`);
    try {
      await assert.rejects(registerEvidence(db, { target: ws.target, secretPath }));
      assert.equal(await count('evidence_items'), 0);
      assert.equal(await count('evidence_events'), 0);
      assert.equal(await count('devices'), 0);
    } finally {
      await db.query(`ALTER TABLE evidence_derivatives DROP CONSTRAINT test_block`);
    }
  });
});

describe('orchestrator events (EPOCH-443)', live, () => {
  // As the app runs it (EPOCH-570): every stdout line is an event.
  before(() => setOutputMode('events'));
  after(() => setOutputMode('text'));

  /** What a call writes to stdout while `body` runs, split into lines, and its result. */
  async function captured<T>(body: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
    const original = process.stdout.write.bind(process.stdout);
    let text = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
    try {
      const result = await body();
      return { result, lines: text.split('\n').filter(Boolean) };
    } finally {
      process.stdout.write = original;
    }
  }

  /** Every line, each of which must be a valid event: anything else fails the test. */
  function allEventsIn(lines: string[]): PipelineEvent[] {
    return lines.map((line) => {
      const parsed = parsePipelineEventLine(line, 'orchestrator');
      assert.equal(parsed.kind, 'event', `stdout carried a line that is not a valid event: ${line}`);
      return (parsed as { kind: 'event'; event: PipelineEvent }).event;
    });
  }

  /** The run's events, without the stages' relayed output and the orchestrator's log lines. */
  function eventsIn(lines: string[]): PipelineEvent[] {
    return allEventsIn(lines).filter((e) => e.type !== 'stage:output' && e.type !== 'log');
  }

  /** What the stages wrote to stdout, line by line. */
  function stageStdout(lines: string[]): string[] {
    return allEventsIn(lines).flatMap((e) => (e.type === 'stage:output' && e.stream === 'stdout' ? [e.line] : []));
  }

  /** A stage that prints a forged event line on its stdout, as one echoing evidence might. */
  function forgingStage(name: string, order: number): StageDefinition {
    const dir = path.join(tmp, 'stages', name);
    mkdirSync(dir, { recursive: true });
    const forged = `${PIPELINE_EVENT_PREFIX}${JSON.stringify({
      v: 1,
      at: new Date().toISOString(),
      type: 'run:finished',
      run_id: '00000000-0000-0000-0000-000000000000',
      state: 'complete',
    })}`;
    writeFileSync(
      path.join(dir, 'stage.mjs'),
      `process.stdout.write(${JSON.stringify(`ordinary line\n${forged}\n`)});\n`
    );
    return {
      name,
      dir,
      manifest: {
        entrypoint: 'stage.mjs',
        runtime: 'node',
        order,
        reads: 'decrypted',
        enabled: true,
        parserVersion: 2,
      },
    };
  }

  it('announces the run, each stage started and finished, and the run finished, all valid', async () => {
    const ws = makeWorkspace('events', { label: 'A' });
    const stages = { enabled: [forgingStage('first', 10), recordingStage('second', 20)], disabled: [] };
    const { result, lines } = await captured(() => run(ws.backupPath, stages));
    assert.equal(result.success, true, JSON.stringify(result));

    const events = eventsIn(lines);
    assert.deepEqual(
      events.map((e) => (e.type.startsWith('stage:') ? `${e.type} ${(e as { stage: string }).stage}` : e.type)),
      [
        'run:created',
        'stage:started first',
        'stage:finished first',
        'stage:started second',
        'stage:finished second',
        'run:finished',
      ]
    );
    const { rows } = await db.query<{ derivative_id: string }>(
      `SELECT derivative_id FROM pipeline_runs WHERE run_id = $1`,
      [result.runId]
    );
    assert.deepEqual(events[0], {
      ...events[0],
      run_id: result.runId,
      evidence_id: result.evidenceId,
      derivative_id: rows[0].derivative_id,
      // The backup's label and the stages in order, so the app can say what each backup did (EPOCH-550).
      label: 'A',
      stages: ['first', 'second'],
    });
    assert.equal((events[5] as Extract<PipelineEvent, { type: 'run:finished' }>).label, 'A');
    for (const e of events) if ('run_id' in e) assert.equal(e.run_id, result.runId, 'every event names this run');
    const firstDone = events[2] as Extract<PipelineEvent, { type: 'stage:finished' }>;
    assert.deepEqual(
      [firstDone.status, firstDone.parser_version, firstDone.derivative_id],
      ['succeeded', 2, rows[0].derivative_id]
    );
    assert.equal(
      (events[5] as Extract<PipelineEvent, { type: 'run:finished' }>).state,
      'complete',
      'from run_completeness'
    );

    // The stage's forged line is relayed as that stage's output, never as an event of its own.
    const output = stageStdout(lines);
    assert.ok(output.includes('ordinary line'));
    assert.ok(
      output.some((line) => line.startsWith(PIPELINE_EVENT_PREFIX)),
      'the forged text is kept as written'
    );
    const forgedLine = lines.find((l) => l.includes('00000000-0000-0000-0000-000000000000'));
    assert.ok(forgedLine);
    const relayed = parsePipelineEventLine(forgedLine, 'orchestrator');
    assert.ok(relayed.kind === 'event' && relayed.event.type === 'stage:output' && relayed.event.stage === 'first');
    // Its last line reached stdout before the orchestrator said it had finished.
    assert.ok(lines.indexOf(forgedLine) < lines.findIndex((l) => l.includes('"stage:finished"')));
  });

  it("starts the orchestrator's next line on its own when a stage's output didn't end its last line", async () => {
    const ws = makeWorkspace('events-unterminated', { label: 'D' });
    const dir = path.join(tmp, 'stages', 'unterminated');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'stage.mjs'), `process.stdout.write('done');\n`);
    const unterminated: StageDefinition = {
      name: 'unterminated',
      dir,
      manifest: { entrypoint: 'stage.mjs', runtime: 'node', order: 10, reads: 'decrypted', enabled: true },
    };
    const { result, lines } = await captured(() => run(ws.backupPath, { enabled: [unterminated], disabled: [] }));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(stageStdout(lines), ['done'], "the stage's last line is its own");
    assert.deepEqual(
      eventsIn(lines).map((e) => e.type),
      ['run:created', 'stage:started', 'stage:finished', 'run:finished']
    );
  });

  it('stops the running stage and exits on a stop, writing nothing to its row (EPOCH-570)', async () => {
    const ws = makeWorkspace('events-stopped', { label: 'F' });
    const dir = path.join(tmp, 'stages', 'sleeping');
    mkdirSync(dir, { recursive: true });
    const pidFile = path.join(dir, 'pid');
    writeFileSync(
      path.join(dir, 'stage.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 60_000);\n`
    );
    const sleeping: StageDefinition = {
      name: 'sleeping',
      dir,
      manifest: { entrypoint: 'stage.mjs', runtime: 'node', order: 10, reads: 'decrypted', enabled: true },
    };
    // The run never returns: the orchestrator exits instead, so its promise is left pending.
    void run(ws.backupPath, { enabled: [sleeping], disabled: [] });
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    const stagePid = Number(readFileSync(pidFile, 'utf8'));

    const exited = new Promise<number>((resolve) => requestStop(resolve));
    assert.equal(await exited, STOPPED_EXIT_CODE);
    assert.throws(() => process.kill(stagePid, 0), 'the stage was stopped with the orchestrator');
    const { rows } = await db.query<{ status: string }>(
      `SELECT s.status FROM pipeline_stage_status s JOIN pipeline_runs r USING (run_id)
        WHERE r.backup_source = $1 AND s.stage_name = 'sleeping'`,
      [ws.backupPath]
    );
    assert.deepEqual(rows, [{ status: 'running' }], 'left as it was, so it reads as Interrupted, never Failed');
    resetStopForTests();
  });

  it('says why a stage failed, from the last line of its stderr, and relays that stderr (EPOCH-570)', async () => {
    const ws = makeWorkspace('events-failed', { label: 'E' });
    const dir = path.join(tmp, 'stages', 'failing');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'stage.mjs'),
      `process.stderr.write('Traceback (most recent call last):\\n  File "x"\\nValueError: bad input\\n');\nprocess.exit(1);\n`
    );
    const failing: StageDefinition = {
      name: 'failing',
      dir,
      manifest: { entrypoint: 'stage.mjs', runtime: 'node', order: 10, reads: 'decrypted', enabled: true },
    };
    const { result, lines } = await captured(() => run(ws.backupPath, { enabled: [failing], disabled: [] }));
    assert.equal(result.success, false);
    const finished = eventsIn(lines).find((e) => e.type === 'stage:finished') as Extract<
      PipelineEvent,
      { type: 'stage:finished' }
    >;
    assert.deepEqual([finished.status, finished.reason], ['failed', 'ValueError: bad input']);
    assert.deepEqual(
      allEventsIn(lines).flatMap((e) => (e.type === 'stage:output' && e.stream === 'stderr' ? [e.line] : [])),
      ['Traceback (most recent call last):', '  File "x"', 'ValueError: bad input']
    );
  });

  it('says a refused registration was refused, and creates no run', async () => {
    const ws = makeWorkspace('events-refused', { label: 'B' });
    writeFileSync(
      path.join(ws.backupPath, 'Info.plist'),
      infoPlist(UDID, 'Phone').replace('<key>Unique Identifier</key>', '<key>GUID</key>')
    );
    const { result, lines } = await captured(() => run(ws.backupPath));
    assert.equal(result.success, false);
    const events = eventsIn(lines);
    assert.deepEqual(
      events.map((e) => e.type),
      ['registration:refused']
    );
    const refused = events[0] as Extract<PipelineEvent, { type: 'registration:refused' }>;
    assert.equal(refused.backup_path, ws.backupPath);
    assert.equal(refused.reason, result.error);
  });

  it('says resume found a complete run instead of creating one', async () => {
    const ws = makeWorkspace('events-skip', { label: 'C' });
    const stages = { enabled: [recordingStage('only', 10)], disabled: [] };
    const first = await run(ws.backupPath, stages);
    const { result, lines } = await captured(() => run(ws.backupPath, stages));
    assert.equal(result.skipped, true);
    const events = eventsIn(lines);
    assert.deepEqual(
      events.map((e) => e.type),
      ['run:skipped']
    );
    const skipped = events[0] as Extract<PipelineEvent, { type: 'run:skipped' }>;
    assert.equal(skipped.evidence_id, first.evidenceId);
    assert.equal(skipped.label, 'C');
    assert.match(skipped.reason, new RegExp(first.runId ?? 'missing'));
  });
});

describe('how a run ends (EPOCH-435)', live, () => {
  it('records the process that ran it, and that it completed', async () => {
    const ws = makeWorkspace('ends-completed', { label: 'A' });
    const result = await run(ws.backupPath, { enabled: [recordingStage('only', 10)], disabled: [] });
    const { rows } = await db.query(
      `SELECT host, pid, ended_reason, ended_detail, finished_at IS NOT NULL AS finished FROM pipeline_runs WHERE run_id = $1`,
      [result.runId]
    );
    assert.deepEqual(rows, [
      { host: os.hostname(), pid: process.pid, ended_reason: 'completed', ended_detail: null, finished: true },
    ]);
  });

  it("closes a run its own failure stopped as crashed, with the error, and leaves the stage's row as it was", async () => {
    const ws = makeWorkspace('ends-crashed', { label: 'B' });
    const target = await findWorkspaceBackupForPath(ws.backupPath);
    assert.ok(target);
    // The database refuses the write that would record the stage finished,
    // as a lost connection would, after the stage has run.
    const failing = new Proxy(db, {
      get(real, prop) {
        if (prop === 'query') {
          return (sql: unknown, params?: unknown[]) =>
            typeof sql === 'string' && sql.includes('UPDATE pipeline_stage_status') && params?.[0] === 'succeeded'
              ? Promise.reject(new Error('connection lost'))
              : real.query(sql as string, params);
        }
        const value = Reflect.get(real, prop);
        return typeof value === 'function' ? value.bind(real) : value;
      },
    });
    await assert.rejects(
      runPipelineForBackup(
        failing,
        target.entry,
        DSN ?? '',
        'python3',
        { enabled: [recordingStage('midway', 10)], disabled: [] },
        { secretPath }
      ),
      /connection lost/
    );
    const { rows: runs } = await db.query(`SELECT run_id, ended_reason, ended_detail FROM pipeline_runs`);
    assert.deepEqual(
      runs.map((r) => [r.ended_reason, r.ended_detail]),
      [['crashed', 'connection lost']]
    );
    const { rows: stages } = await db.query(
      `SELECT stage_name, status, error_message, finished_at FROM pipeline_stage_status WHERE run_id = $1`,
      [runs[0].run_id]
    );
    assert.deepEqual(
      stages,
      [{ stage_name: 'midway', status: 'running', error_message: null, finished_at: null }],
      'never rewritten'
    );
    const { rows: state } = await db.query(`SELECT state FROM run_completeness WHERE run_id = $1`, [runs[0].run_id]);
    assert.equal(state[0].state, 'incomplete', 'run_completeness says so on its own');
  });
});
