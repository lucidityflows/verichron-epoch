/**
 * The real-data check of the sanitizer (EPOCH-570, docs/event-log.md §6.5),
 * on a synthetic workspace: it passes a log the writer sanitized, and fails
 * one that holds a known value.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createWorkspaceManifestBackup,
  emptyWorkspaceManifest,
  renderPipelineEvent,
  renderTaskLogEntry,
} from '@verichron/contracts';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { checkTaskLogs } from './sanitizerCheck';
import { TaskLog } from './taskLog';

const UDID = '00008030-000A1B2C3D4E5F60';
const LABEL = '2026-10-15T180523Z';
let tmp: string;
let workspace: string;
let backupPath: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sanitizer-check-'));
  workspace = path.join(tmp, 'workspace');
  backupPath = path.join(tmp, 'source', LABEL, UDID);
  mkdirSync(backupPath, { recursive: true });
  writeFileSync(
    path.join(backupPath, 'Info.plist'),
    `<plist><dict><key>Unique Identifier</key><string>${UDID}</string></dict></plist>`
  );
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    path.join(workspace, 'workspace.json'),
    JSON.stringify({ ...emptyWorkspaceManifest(), backups: [createWorkspaceManifestBackup(LABEL, backupPath)] })
  );
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function writtenLog() {
  const log = await TaskLog.open(
    {
      workspace,
      kind: 'prepare',
      labels: [LABEL],
      options: {},
      backups: [{ label: LABEL, path: backupPath }],
      source: path.join(tmp, 'source'),
      appRoot: path.join(tmp, 'app'),
      appVersion: '0.1.0',
      message: 'Prepare Evidence started for 1 backup',
    },
    () => undefined
  );
  log.line(
    'processor',
    'stdout',
    renderPipelineEvent({ type: 'log', level: 'info', message: `found ${backupPath}`, label: LABEL })
  );
  return log;
}

describe('checkTaskLogs', () => {
  it('passes a log the writer sanitized, counting its markers, and quotes lines only in the review', async () => {
    const log = await writtenLog();
    await log.finish({ outcome: 'succeeded', exitCode: 0, signal: null, reported: true, failedLabels: [] }, 'done');
    const { report, review } = await checkTaskLogs(workspace, path.join(tmp, 'app'));
    assert.equal(report.pass, true, JSON.stringify(report));
    assert.deepEqual(report.residue, {});
    assert.ok((report.markers.device ?? 0) >= 1);
    assert.ok(!JSON.stringify(report).includes(UDID), 'the report holds counts, never a value');
    assert.match(review, /\[device 2026-10-15T180523Z\]/);
    assert.ok(!review.includes(UDID));
  });

  it('fails a log that holds a known value, naming its class only', async () => {
    const log = await writtenLog();
    await log.finish({ outcome: 'succeeded', exitCode: 0, signal: null, reported: true, failedLabels: [] }, 'done');
    // A valid entry the writer would never have written: the UDID left in its message.
    appendFileSync(
      path.join(workspace, 'logs', log.file),
      renderTaskLogEntry({
        v: 1,
        task_id: log.taskId,
        seq: 99,
        at: '2026-10-18T15:30:02.123Z',
        clock: 'received',
        level: 'info',
        source: 'app',
        label: null,
        step: null,
        kind: 'message',
        message: `leaked ${UDID.toLowerCase()}`,
      })
    );
    const { report } = await checkTaskLogs(workspace, path.join(tmp, 'app'));
    assert.equal(report.pass, false);
    assert.deepEqual(report.residue, { device: 1 });
  });
});
