/**
 * EPOCH-404 against real Postgres (R33): pre-flight registration,
 * evidence-keyed resume, the canonical completeness predicate, and the
 * identity each stage is given. Each run creates a throwaway database, applies
 * the migrations, and drops it; workspaces are built on disk in a temp dir.
 *
 * Needs TEST_DATABASE_URL (a role that may CREATE DATABASE). Skipped locally
 * when unset; fails in CI. Run: pnpm --filter @verichron/orchestrator test
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import pg from 'pg';

import { CHECK_MARKER, DECRYPT_MARKER, renderDerivativeMarker } from '@verichron/contracts';

import { getRunState, hasSucceededRun } from './db.js';
import { runPipelineForBackup } from './pipeline.js';
import { deviceKey, loadDeviceSecret, readPlistStrings, registerEvidence, RegistrationError } from './registration.js';
import type { StageDefinition, StageSet } from './types.js';

const DSN = process.env.TEST_DATABASE_URL;
const MIGRATIONS = path.resolve(import.meta.dirname, '../../../packages/etl-db-writer/migrations');
const UDID = '00008030-001A2B3C4D5E6F70';

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
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
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
                  evidence_events, evidence_derivatives, evidence_locations, evidence_items, devices CASCADE`);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Workspace {
  workspace: string;
  backupPath: string;
  resultsPath: string;
  sidecarPath: string;
  contentRoot: string;
}

function infoPlist(udid: string, name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Device Name</key><string>${name}</string>
  <key>Unique Identifier</key><string>${udid}</string>
</dict></plist>`;
}

/** A workspace as mvt-runner leaves it: decrypted backup, results, and the
 * EPOCH-401 evidence files (content-addressed manifest + sidecar). */
function makeWorkspace(
  name: string,
  {
    manifest = 'a'.repeat(64) + '  Manifest.db\n',
    sourcePath = `/media/source/${name}`,
    label = 'BK1',
    results = true,
  }: { manifest?: string; sourcePath?: string; label?: string; results?: boolean } = {}
): Workspace {
  const workspace = path.join(tmp, name);
  const backupPath = path.join(workspace, 'decrypted', label);
  const resultsPath = path.join(workspace, 'results', label);
  mkdirSync(backupPath, { recursive: true });
  writeFileSync(path.join(backupPath, 'Manifest.db'), '');
  writeFileSync(path.join(backupPath, 'Info.plist'), infoPlist(UDID, 'Alice &amp; Bob&apos;s iPhone'));
  const contentRoot = createHash('sha256').update(manifest).digest('hex');
  // Provenance markers, as mvt-runner writes them once each derivative is done.
  writeFileSync(path.join(backupPath, DECRYPT_MARKER), renderDerivativeMarker(contentRoot));
  if (results) {
    mkdirSync(resultsPath, { recursive: true });
    writeFileSync(path.join(resultsPath, CHECK_MARKER), renderDerivativeMarker(contentRoot));
  }

  const evidenceDir = path.join(workspace, 'evidence', label);
  mkdirSync(path.join(evidenceDir, 'manifests'), { recursive: true });
  writeFileSync(path.join(evidenceDir, 'manifests', `${contentRoot}.sha256`), manifest);
  const sidecarPath = path.join(evidenceDir, 'sidecar.json');
  writeFileSync(
    sidecarPath,
    JSON.stringify({
      schema_version: 1,
      evidence_name: label,
      algorithm: 'sha256',
      content_root: contentRoot,
      manifest_path: `evidence/${label}/manifests/${contentRoot}.sha256`,
      file_count: 1,
      total_bytes: 0,
      source_path: sourcePath,
      hashed_at: '2026-10-08T00:00:00.000Z',
      tool: { name: 'mvt-runner', version: '0.1.0' },
    })
  );
  return { workspace, backupPath, resultsPath, sidecarPath, contentRoot };
}

/** A node stage that records the arguments it was given. */
function recordingStage(name: string, order: number, manifest: Partial<StageDefinition['manifest']> = {}): StageDefinition {
  const dir = path.join(tmp, 'stages', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'stage.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(path.join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));\n`
  );
  return {
    name,
    dir,
    manifest: { entrypoint: 'stage.mjs', runtime: 'node', order, requiresResultsPath: false, enabled: true, ...manifest },
  };
}

function argsOf(stage: StageDefinition): Record<string, string> {
  const argv: string[] = JSON.parse(readFileSync(path.join(stage.dir, 'argv.json'), 'utf8'));
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i]] = argv[i + 1];
  return out;
}

const NO_STAGES: StageSet = { enabled: [], disabled: [] };
const run = (backupPath: string, stages: StageSet = NO_STAGES) =>
  runPipelineForBackup(db, backupPath, DSN ?? '', 'python3', stages, { secretPath });

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
    const second = await run(ws.backupPath);

    assert.equal(second.skipped, true, 'the evidence already has a complete run, so it is skipped');
    assert.equal(second.evidenceId, first.evidenceId);
    assert.equal(await count('evidence_items'), 1);
    assert.equal(await count('evidence_locations'), 2);
    assert.equal(await count('pipeline_runs'), 1, 'no second run for complete evidence');
    const events = await db.query<{ kind: string }>(`SELECT kind FROM evidence_events ORDER BY event_id`);
    assert.deepEqual(events.rows.map((e) => e.kind), [
      'registered', 'location_added', 'derivative_registered', 'derivative_registered', 'location_added',
    ]);
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
    assert.equal(rows.length, 2, 'one decrypt and one results derivative, not new ones');
    assert.ok(rows.every((r) => r.path.startsWith(moved)), 'each derivative records its new location');
  });

  it('every run row carries its evidence and derivative', async () => {
    const ws = makeWorkspace('stamped');
    const result = await run(ws.backupPath);
    const { rows } = await db.query(`SELECT evidence_id, derivative_id FROM pipeline_runs WHERE run_id = $1`, [result.runId]);
    assert.equal(rows[0].evidence_id, result.evidenceId);
    assert.ok(rows[0].derivative_id);
  });

  for (const [label, corrupt] of [
    ['a missing sidecar', (ws: Workspace) => rmSync(ws.sidecarPath)],
    ['a malformed sidecar', (ws: Workspace) => writeFileSync(ws.sidecarPath, '{"schema_version": 1}')],
    ['a sidecar whose manifest does not match its root', (ws: Workspace) => {
      const manifest = path.join(ws.workspace, 'evidence', 'BK1', 'manifests', `${ws.contentRoot}.sha256`);
      writeFileSync(manifest, 'tampered\n');
    }],
    ['a sidecar pointing outside its evidence directory', (ws: Workspace) => {
      const sidecar = JSON.parse(readFileSync(ws.sidecarPath, 'utf8'));
      writeFileSync(ws.sidecarPath, JSON.stringify({ ...sidecar, manifest_path: '../../etc/passwd' }));
    }],
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
    ['a decrypt made from an earlier version of the backup', (ws: Workspace) =>
      writeFileSync(path.join(ws.backupPath, DECRYPT_MARKER), renderDerivativeMarker('f'.repeat(64)))],
    ['a decrypt with no provenance marker', (ws: Workspace) => rmSync(path.join(ws.backupPath, DECRYPT_MARKER))],
    ['mvt results made from an earlier version of the backup', (ws: Workspace) =>
      writeFileSync(path.join(ws.resultsPath, CHECK_MARKER), renderDerivativeMarker('f'.repeat(64)))],
    ['a results path that is a file, not a directory', (ws: Workspace) => {
      rmSync(ws.resultsPath, { recursive: true });
      writeFileSync(ws.resultsPath, 'not a directory');
    }],
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

  it('results whose check never finished are not registered, and results stages stop before starting', async () => {
    const ws = makeWorkspace('unchecked');
    rmSync(path.join(ws.resultsPath, CHECK_MARKER));
    const reader = recordingStage('needs-results', 10, { requiresResultsPath: true, parserVersion: 1 });
    const result = await run(ws.backupPath, { enabled: [reader], disabled: [] });
    assert.equal(result.success, false);
    const kinds = await db.query<{ kind: string }>(`SELECT kind FROM evidence_derivatives`);
    assert.deepEqual(kinds.rows.map((r) => r.kind), ['decrypted']);
    const stage = await db.query(`SELECT status, error_message FROM pipeline_stage_status WHERE run_id = $1`, [result.runId]);
    assert.equal(stage.rows[0].status, 'failed');
    assert.match(stage.rows[0].error_message, /no results directory was registered/);
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
    await db.query(`UPDATE pipeline_runs SET finished_at = NULL`); // force a re-run
    rmSync(secretPath); // a lost per-install secret: new key for the same phone
    const second = await run(ws.backupPath);
    assert.equal(second.evidenceId, first.evidenceId);
    assert.equal(await count('evidence_items'), 1);
  });
});

describe('stages and the completeness predicate', live, () => {
  it('passes each stage its evidence, derivative and parser version', async () => {
    const ws = makeWorkspace('args');
    const reader = recordingStage('reader', 10, { parserVersion: 3 });
    const resultsReader = recordingStage('results-reader', 20, { parserVersion: 2, requiresResultsPath: true });
    const report = recordingStage('report', 1000);
    const result = await run(ws.backupPath, { enabled: [reader, resultsReader, report], disabled: [] });
    assert.equal(result.success, true, JSON.stringify(result));

    const { rows } = await db.query<{ kind: string; derivative_id: string }>(
      `SELECT kind, derivative_id FROM evidence_derivatives WHERE evidence_id = $1`,
      [result.evidenceId]
    );
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.derivative_id]));

    assert.equal(argsOf(reader)['--evidence-id'], result.evidenceId);
    assert.equal(argsOf(reader)['--derivative-id'], byKind.decrypted);
    assert.equal(argsOf(reader)['--parser-version'], '3');
    assert.equal(argsOf(resultsReader)['--derivative-id'], byKind.mvt_results, 'results stages read the results derivative');
    assert.equal(argsOf(resultsReader)['--parser-version'], '2');
    assert.equal(argsOf(report)['--parser-version'], undefined, 'a stage that declares none is passed none');
  });

  it('records disabled stages as skipped, and skipped never makes a run incomplete', async () => {
    const ws = makeWorkspace('skips');
    const disabled = recordingStage('stub', 30, { enabled: false });
    const result = await run(ws.backupPath, { enabled: [], disabled: [disabled] });
    const { rows } = await db.query(`SELECT stage_name, status FROM pipeline_stage_status WHERE run_id = $1`, [result.runId]);
    assert.deepEqual(rows, [{ stage_name: 'stub', status: 'skipped' }]);
    assert.equal(await getRunState(db, result.runId!), 'complete');
  });

  it('a finished run with a stage stuck pending or running is incomplete, not succeeded', async () => {
    const ws = makeWorkspace('killed');
    const result = await run(ws.backupPath, { enabled: [recordingStage('ok', 10)], disabled: [] });
    const derivative = await db.query(`SELECT derivative_id FROM pipeline_runs WHERE run_id = $1`, [result.runId]);
    for (const stuck of ['pending', 'running']) {
      await db.query(`UPDATE pipeline_stage_status SET status = $1 WHERE run_id = $2`, [stuck, result.runId]);
      assert.equal(await getRunState(db, result.runId!), 'incomplete', `a stage left ${stuck} by a killed process`);
      assert.equal(await hasSucceededRun(db, result.evidenceId!, derivative.rows[0].derivative_id), false);
    }
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

describe('registration in isolation', live, () => {
  it('is all-or-nothing: a refusal mid-transaction leaves nothing behind', async () => {
    const ws = makeWorkspace('atomic', { results: false });
    // Make the derivative insert fail inside the transaction.
    await db.query(`ALTER TABLE evidence_derivatives ADD CONSTRAINT test_block CHECK (path <> '${ws.backupPath}')`);
    try {
      await assert.rejects(registerEvidence(db, { backupPath: ws.backupPath, secretPath }));
      assert.equal(await count('evidence_items'), 0);
      assert.equal(await count('evidence_events'), 0);
      assert.equal(await count('devices'), 0);
    } finally {
      await db.query(`ALTER TABLE evidence_derivatives DROP CONSTRAINT test_block`);
    }
  });
});
