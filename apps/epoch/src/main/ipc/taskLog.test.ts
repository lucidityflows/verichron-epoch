/**
 * The task log's writer (EPOCH-570, docs/event-log.md §6, §7): every line
 * sanitized and validated before it is kept, shown or saved; the file a
 * reader can trust after a restart. Synthetic identifiers in real formats.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderPipelineEvent, type TaskLogEntry } from '@verichron/contracts';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { TaskLog, listTaskLogs, readSavedTaskLog, type TaskLogSetup } from './taskLog';

const UDID = '00008030-000A1B2C3D4E5F60';
const LABEL = '2026-10-15T180523Z';
let tmp: string;
let workspace: string;
let source: string;
let backupPath: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'task-log-'));
  workspace = path.join(tmp, 'workspace');
  source = path.join(tmp, 'source');
  backupPath = path.join(source, LABEL, UDID);
  mkdirSync(backupPath, { recursive: true });
  writeFileSync(
    path.join(backupPath, 'Info.plist'),
    `<plist><dict><key>Unique Identifier</key><string>${UDID}</string>` +
      `<key>Serial Number</key><string>F2LZK1ABCD12</string><key>Device Name</key><string>iPhone</string></dict></plist>`
  );
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function openLog(more: Partial<TaskLogSetup> = {}) {
  const seen: TaskLogEntry[] = [];
  const log = await TaskLog.open(
    {
      workspace,
      kind: 'prepare',
      labels: [LABEL],
      options: { force_decrypt: false },
      backups: [{ label: LABEL, path: backupPath }],
      source,
      appRoot: path.join(tmp, 'app'),
      appVersion: '0.1.0',
      message: 'Prepare Evidence started for 1 backup',
      ...more,
    },
    (entry) => seen.push(entry)
  );
  return { log, seen };
}

const result = {
  outcome: 'succeeded' as const,
  exitCode: 0,
  signal: null,
  reported: true,
  failedLabels: [],
};

describe('TaskLog', () => {
  it('creates the log in <workspace>/logs/, private to the examiner, and writes its header first', async () => {
    const { log, seen } = await openLog();
    await log.finish(result, 'Prepare Evidence finished');
    assert.match(log.file, /^prepare-\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{8}\.ndjson$/);
    const file = path.join(workspace, 'logs', log.file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    const read = await readSavedTaskLog(workspace, log.file);
    assert.deepEqual(read.entries, seen, 'what was shown is what was saved');
    assert.equal(read.entries[0].kind, 'task:started');
    assert.equal(read.entries.at(-1)?.kind, 'task:finished');
    assert.deepEqual([read.finished, read.truncated, read.invalid], [true, false, []]);
  });

  it("keeps a producer's event with its own level and time, sanitized, and hands back the event", async () => {
    const { log } = await openLog();
    const line = renderPipelineEvent({
      type: 'backup:step',
      label: LABEL,
      step: 'hash',
      status: 'error',
      reason: `could not read ${backupPath}/Manifest.db in ${workspace}`,
    });
    const { entry, event } = log.line('processor', 'stdout', line);
    assert.equal(event?.type, 'backup:step', 'the event, for the session to follow');
    assert.equal(entry.kind, 'event');
    assert.equal(entry.level, 'error', 'from the event, not its text');
    assert.equal(entry.clock, 'source');
    assert.deepEqual([entry.label, entry.step, entry.source], [LABEL, 'hash', 'processor']);
    const expected = `could not read <source>/${LABEL}/[device ${LABEL}]/Manifest.db in <workspace>`;
    assert.equal(entry.message, `Checking the backup files failed: ${expected}`);
    assert.equal(entry.kind === 'event' && entry.event.type === 'backup:step' && entry.event.reason, expected);
    await log.finish(result, 'done');
  });

  it("keeps lines that are not events as debug output, by their source, and a tool's lines under the tool", async () => {
    const { log } = await openLog();
    const out = log.line('processor', 'stderr', `Traceback in ${path.join(tmp, 'app')}/x.py`).entry;
    assert.deepEqual(
      [out.kind, out.level, out.source, out.message],
      ['output', 'debug', 'processor', 'Traceback in <app>/x.py']
    );
    const tool = log.line(
      'processor',
      'stdout',
      renderPipelineEvent({ type: 'tool:output', tool: 'ileapp', stream: 'stderr', line: 'Error was x', label: LABEL })
    ).entry;
    assert.deepEqual([tool.level, tool.source, tool.step], ['debug', 'tool:ileapp', 'ileapp']);
    await log.finish(result, 'done');
  });

  it('never replaces the Device Name, and replaces the serial number wherever it appears', async () => {
    const { log } = await openLog();
    const entry = log.app('info', 'iphone_backup_decrypt 0.10.0 read serial F2LZK1ABCD12');
    assert.equal(entry.message, `iphone_backup_decrypt 0.10.0 read serial [serial ${LABEL}]`);
    await log.finish(result, 'done');
  });

  it('records an event it cannot read as an error, and keeps the line, never trusting it', async () => {
    const { log, seen } = await openLog();
    log.line(
      'orchestrator',
      'stdout',
      renderPipelineEvent({ type: 'password:required', label: LABEL, attempt: 1, max: 3 })
    );
    const [error, kept] = seen.slice(-2);
    assert.deepEqual([error.kind, error.level], ['message', 'error']);
    assert.match(
      error.message,
      /the orchestrator wrote an event the app could not read: the orchestrator does not emit/
    );
    assert.deepEqual([kept.kind, kept.level], ['output', 'debug']);
    await log.finish(result, 'done');
  });

  it('removes a password that reaches the output and says so; the tripwire ends with the task', async () => {
    const { log, seen } = await openLog();
    log.addSecret('correct-horse');
    const { entry } = log.line('processor', 'stderr', 'wrong key correct-horse');
    assert.equal(entry.message, 'wrong key [password]');
    assert.match(seen.at(-1)!.message, /a password reached the output; it was removed/);
    assert.equal(seen.at(-1)!.level, 'error');
    await log.finish(result, 'done');
    const saved = readFileSync(path.join(workspace, 'logs', log.file), 'utf8');
    assert.ok(!saved.includes('correct-horse'), 'never saved');
  });

  it('records how the task ended, and refuses an entry after it', async () => {
    const { log } = await openLog();
    const finished = await log.finish(
      { outcome: 'crashed', exitCode: null, signal: 'SIGKILL', reported: false, failedLabels: [LABEL] },
      'Prepare Evidence stopped: the processor ended (signal SIGKILL) without reporting a result'
    );
    assert.equal(finished.level, 'error');
    assert.ok(finished.kind === 'task:finished');
    assert.deepEqual(finished.kind === 'task:finished' && finished.result, {
      outcome: 'crashed',
      exit_code: null,
      signal: 'SIGKILL',
      reported: false,
      failed_labels: [LABEL],
      log_write_error: null,
    });
    assert.throws(() => log.app('info', 'late'), /already finished/);
  });

  it('does not start when its log cannot be created: no log, no task', async () => {
    writeFileSync(path.join(tmp, 'not-a-folder'), '');
    await assert.rejects(openLog({ workspace: path.join(tmp, 'not-a-folder') }));
  });
});

describe('saved logs', () => {
  it('lists each log by its header and result, newest first, and says when a task never finished', async () => {
    const first = await openLog({ labels: ['A'], backups: [] });
    await first.log.finish(result, 'done');
    const second = await openLog({ kind: 'analyze', labels: ['B'], backups: [] });
    const logs = await listTaskLogs(workspace);
    assert.equal(logs.length, 2);
    const byFile = new Map(logs.map((l) => [l.file, l]));
    assert.deepEqual(
      (({ kind, labels, finished, outcome, problems }) => ({ kind, labels, finished, outcome, problems }))(
        byFile.get(first.log.file)!
      ),
      { kind: 'prepare', labels: ['A'], finished: true, outcome: 'succeeded', problems: 0 }
    );
    assert.deepEqual(
      (({ kind, finished, outcome }) => ({ kind, finished, outcome }))(byFile.get(second.log.file)!),
      { kind: 'analyze', finished: false, outcome: null },
      'the app was closed while it ran: Interrupted'
    );
    await second.log.finish(result, 'done');
  });

  it('reports a cut-off last line and an invalid one, and never reads a path for a name', async () => {
    const { log } = await openLog({ backups: [] });
    await log.finish(result, 'done');
    const file = path.join(workspace, 'logs', log.file);
    appendFileSync(file, '{"v":1}\n{"v":1,"task_id"');
    const read = await readSavedTaskLog(workspace, log.file);
    assert.deepEqual([read.invalid.length, read.truncated], [1, true]);
    assert.equal((await listTaskLogs(workspace))[0].problems, 2);
    await assert.rejects(readSavedTaskLog(workspace, '../workspace.json'), /not a task log's name/);
  });
});
