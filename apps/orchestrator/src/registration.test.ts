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
  deriveRunSummaryPath,
  ILEAPP_MARKER,
  renderDecryptMarker,
  renderIleappMarker,
  type DecryptParams,
} from '@verichron/contracts';

import { getRunState, hasCompleteRunFor } from './db.js';
import { runPipelineForBackup } from './pipeline.js';
import { readRunSummary } from './runSummary.js';
import { deviceKey, loadDeviceSecret, readPlistStrings, registerEvidence, RegistrationError } from './registration.js';
import type { StageDefinition, StageSet } from './types.js';

const DSN = process.env.TEST_DATABASE_URL;
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
                  evidence_events, evidence_derivatives, evidence_locations, evidence_items, devices CASCADE`);
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
}

function infoPlist(udid: string, name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Device Name</key><string>${name}</string>
  <key>Unique Identifier</key><string>${udid}</string>
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
  const backupPath = path.join(workspace, 'decrypted', label);
  const ileappPath = path.join(workspace, 'ileapp', label);
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
      tool: { name: 'processor', version: '0.1.0' },
    })
  );
  return { workspace, backupPath, ileappPath, sidecarPath, contentRoot };
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
        const manifest = path.join(ws.workspace, 'evidence', 'BK1', 'manifests', `${ws.contentRoot}.sha256`);
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
    await db.query(`UPDATE pipeline_runs SET finished_at = NULL`); // force a re-run
    rmSync(secretPath); // a lost per-install secret: new key for the same phone
    const second = await run(ws.backupPath);
    assert.equal(second.evidenceId, first.evidenceId);
    assert.equal(await count('evidence_items'), 1);
  });
});

describe('stages and the completeness predicate', live, () => {
  it('passes each stage its evidence, the derivative it reads (id and path) and its parser version', async () => {
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
  const summaryOf = (backupPath: string, runId: string) => deriveRunSummaryPath(backupPath, runId)!;

  it('a complete run whose summary went missing gets it back when the backup is skipped', async () => {
    const ws = makeWorkspace('summary-repair', { label: 'A' });
    const stages = { enabled: [recordingStage('ok', 10)], disabled: [] };
    const first = await run(ws.backupPath, stages);
    const file = summaryOf(ws.backupPath, first.runId!);
    // What a failed export after the run was marked complete leaves behind.
    rmSync(file);

    const again = await run(ws.backupPath, stages);
    assert.equal(again.skipped, true);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), await readRunSummary(db, first.runId!));
  });

  it("writes each run's summary to its own file, as the database records it", async () => {
    const ws = makeWorkspace('summary-db', { label: 'A' });
    const result = await run(ws.backupPath, { enabled: [recordingStage('ok', 10)], disabled: [] });
    const file = summaryOf(ws.backupPath, result.runId!);
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
    const before = readFileSync(summaryOf(a.backupPath, first.runId!));

    const other = await run(b.backupPath, stages);
    assert.notEqual(other.runId, first.runId);
    assert.ok(readFileSync(summaryOf(b.backupPath, other.runId!)).length > 0);
    assert.deepEqual(readFileSync(summaryOf(a.backupPath, first.runId!)), before);
  });

  it('a failed run writes its summary too, incomplete, and a rerun gets a file of its own', async () => {
    const ws = makeWorkspace('summary-failed', { label: 'A' });
    const failing = recordingStage('fails', 10);
    writeFileSync(path.join(failing.dir, 'stage.mjs'), 'process.exit(3);\n');
    const first = await run(ws.backupPath, { enabled: [failing], disabled: [] });
    const firstFile = summaryOf(ws.backupPath, first.runId!);
    const before = readFileSync(firstFile);
    assert.equal(JSON.parse(before.toString()).state, 'incomplete');

    const second = await run(ws.backupPath, { enabled: [failing], disabled: [] });
    assert.ok(readFileSync(summaryOf(ws.backupPath, second.runId!)).length > 0);
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
      await assert.rejects(registerEvidence(db, { backupPath: ws.backupPath, secretPath }));
      assert.equal(await count('evidence_items'), 0);
      assert.equal(await count('evidence_events'), 0);
      assert.equal(await count('devices'), 0);
    } finally {
      await db.query(`ALTER TABLE evidence_derivatives DROP CONSTRAINT test_block`);
    }
  });
});
