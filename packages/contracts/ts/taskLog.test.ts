/**
 * The task log's entries and the processor's events (EPOCH-570, EPOCH-445;
 * docs/event-log.md §4, §5, §8.1).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EVENT_PRODUCERS,
  PIPELINE_EVENT_PREFIX,
  PipelineEvent,
  eventLevel,
  parsePipelineEventLine,
  renderPipelineEvent,
} from './pipelineEvent.js';
import { TaskLogEntry, readTaskLog, renderTaskLogEntry, taskLogFileName } from './taskLog.js';

const TASK = '1f3a9c2e-0000-4000-8000-000000000001';
const AT = '2026-10-18T15:30:02.123Z';
const LABEL = '2026-10-15T180523Z';

const base = {
  v: 1 as const,
  task_id: TASK,
  at: AT,
  clock: 'received' as const,
  source: 'app',
  label: null,
  step: null,
};

const started: TaskLogEntry = {
  ...base,
  seq: 1,
  kind: 'task:started',
  level: 'info',
  message: 'Prepare Evidence started for 1 backup',
  task: { kind: 'prepare', app_version: '0.1.0', labels: [LABEL], options: { force_decrypt: false } },
};

const finished: TaskLogEntry = {
  ...base,
  seq: 3,
  kind: 'task:finished',
  level: 'info',
  message: 'Prepare Evidence finished',
  result: {
    outcome: 'succeeded',
    exit_code: 0,
    signal: null,
    reported: true,
    failed_labels: [],
    log_write_error: null,
  },
};

function event(body: Record<string, unknown>): PipelineEvent {
  return PipelineEvent.parse({ v: 1, at: AT, ...body });
}

describe('processor events', () => {
  it('render and parse back, from the processor only', () => {
    const line = renderPipelineEvent({ type: 'password:required', label: LABEL, attempt: 1, max: 3 });
    assert.equal(parsePipelineEventLine(line, 'processor').kind, 'event');
    const asOrchestrator = parsePipelineEventLine(line, 'orchestrator');
    assert.deepEqual(asOrchestrator, { kind: 'invalid', error: 'the orchestrator does not emit "password:required"' });
  });

  it('never carry a password: password:required has no field for one', () => {
    const forged = `${PIPELINE_EVENT_PREFIX}${JSON.stringify({
      v: 1,
      at: AT,
      type: 'password:required',
      label: LABEL,
      attempt: 1,
      max: 3,
      password: 'secret',
    })}`;
    assert.equal(parsePipelineEventLine(forged, 'processor').kind, 'invalid');
  });

  it('require a reason for a failed step, and a step and reason for a failed backup only', () => {
    assert.throws(() => event({ type: 'backup:step', label: LABEL, step: 'decrypt', status: 'error' }));
    assert.ok(event({ type: 'backup:step', label: LABEL, step: 'decrypt', status: 'error', reason: 'wrong password' }));
    assert.throws(() => event({ type: 'backup:finished', label: LABEL, success: false }));
    assert.throws(() =>
      event({ type: 'backup:finished', label: LABEL, success: true, failed_step: 'hash', reason: 'x' })
    );
    assert.ok(event({ type: 'backup:finished', label: LABEL, success: false, failed_step: 'hash', reason: 'x' }));
  });

  it('name a producer for every event type', () => {
    for (const option of PipelineEvent.options) {
      const type = option.shape.type.value;
      assert.ok(EVENT_PRODUCERS[type].length > 0, type);
    }
  });
});

describe('levels', () => {
  it('come from the type and status, and one failure is one error', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ type: 'backup:step', label: LABEL, step: 'decrypt', status: 'error', reason: 'r' }, 'error'],
      [{ type: 'backup:step', label: LABEL, step: 'decrypt', status: 'skipped', reason: 'already done' }, 'info'],
      [{ type: 'backup:finished', label: LABEL, success: false, failed_step: 'decrypt', reason: 'r' }, 'info'],
      [{ type: 'tool:output', tool: 'ileapp', stream: 'stderr', line: 'Traceback' }, 'debug'],
      [{ type: 'ileapp:module', label: LABEL, index: 1, total: 879, module: 'sms' }, 'debug'],
      [{ type: 'log', level: 'warn', message: 'repair could not recover 1 database' }, 'warn'],
    ];
    for (const [body, level] of cases) assert.equal(eventLevel(event(body)), level, String(body.type));
  });
});

describe('task log entries', () => {
  it('render as one validated line and read back', () => {
    const text = renderTaskLogEntry(started) + renderTaskLogEntry(finished);
    const read = readTaskLog(text);
    assert.deepEqual(read, { entries: [started, finished], invalid: [], truncated: false, finished: true });
  });

  it("refuse an event entry whose level isn't the event's", () => {
    const entry = {
      ...base,
      seq: 2,
      kind: 'event',
      level: 'info',
      source: 'processor',
      message: 'decrypt failed',
      event: event({ type: 'backup:step', label: LABEL, step: 'decrypt', status: 'error', reason: 'r' }),
    };
    assert.throws(() => TaskLogEntry.parse(entry), /level comes from its type and status/);
    assert.ok(TaskLogEntry.parse({ ...entry, level: 'error' }));
  });

  it('keep raw output at debug, and the header first', () => {
    const output = { ...base, seq: 2, kind: 'output', stream: 'stdout', level: 'info', message: 'x' };
    assert.throws(() => TaskLogEntry.parse(output), /debug, by its source/);
    assert.throws(() => TaskLogEntry.parse({ ...started, seq: 2 }), /always the first entry/);
  });

  it('accept only the sources the design names', () => {
    for (const source of ['app', 'processor', 'orchestrator', 'stage:ileapp_bridge', 'tool:ileapp']) {
      assert.ok(TaskLogEntry.parse({ ...finished, source }), source);
    }
    for (const source of ['shell', 'tool:', 'stage:Bad Name']) {
      assert.throws(() => TaskLogEntry.parse({ ...finished, source }), source);
    }
  });

  it('report a cut-off last line, and never skip an invalid one', () => {
    const cut = renderTaskLogEntry(started) + renderTaskLogEntry(finished).slice(0, 20);
    assert.deepEqual(readTaskLog(cut), { entries: [started], invalid: [], truncated: true, finished: false });

    const broken = renderTaskLogEntry(started) + '{"v":1}\n' + 'not json\n' + renderTaskLogEntry(finished);
    const read = readTaskLog(broken);
    assert.deepEqual(read.entries, [started, finished]);
    assert.deepEqual(
      read.invalid.map((p) => p.line),
      [2, 3]
    );
    assert.equal(read.truncated, false);
  });

  it('say when the task never finished', () => {
    assert.equal(readTaskLog(renderTaskLogEntry(started)).finished, false);
  });
});

describe('file names', () => {
  it('use the kind, the start in compact UTC and the first 8 of the task id', () => {
    assert.equal(
      taskLogFileName('prepare', new Date('2026-10-18T15:30:02.123Z'), TASK),
      'prepare-2026-10-18T153002Z-1f3a9c2e.ndjson'
    );
    assert.throws(() => taskLogFileName('analyze', new Date(), 'not-a-uuid'));
  });
});
