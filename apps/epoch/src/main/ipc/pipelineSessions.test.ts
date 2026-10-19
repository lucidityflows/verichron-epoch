/**
 * EPOCH-487: Prepare Evidence and Analyze keep their state in the main
 * process, so New Investigation can be left and opened again mid-run. Their
 * progress comes from the producers' typed events (EPOCH-445), never text,
 * and their log is the task log's entries (EPOCH-570).
 */
import assert from 'node:assert/strict';
import { PipelineEvent, type PipelineEventBody, type TaskLogEntry } from '@verichron/contracts';
import { describe, it } from 'vitest';

import { applyPrepareEvent, initPrepareProgress } from '../../shared/prepareProgress';
import type { PrepareState, PullLogState } from '../../shared/types/window';
import { AnalysisSession, KEPT_LOG_LINES, LineSplitter, PrepareSession, PullLogSession } from './pipelineSessions';

const AT = '2026-10-18T15:30:02.123Z';
const TASK = '1f3a9c2e-0000-4000-8000-000000000001';
const event = (body: PipelineEventBody): PipelineEvent => PipelineEvent.parse({ v: 1, at: AT, ...body });

/** A log entry as the task log hands it over. */
function entry(seq: number, message: string): TaskLogEntry {
  return {
    v: 1,
    task_id: TASK,
    seq,
    at: AT,
    clock: 'received',
    level: 'info',
    source: 'app',
    label: null,
    step: null,
    kind: 'message',
    message,
  };
}

describe('prepare progress from events', () => {
  const after = (...events: PipelineEventBody[]) => {
    let state = initPrepareProgress(['BK']);
    events.forEach((body, i) => (state = applyPrepareEvent(state, event(body), 1000 * (i + 1))));
    return state.byLabel.BK;
  };
  const step = (s: string, status: string, more: Record<string, string> = {}) =>
    ({ type: 'backup:step', label: 'BK', step: s, status, ...more }) as PipelineEventBody;

  it('reads bytes hashed, bytes decrypted and the iLEAPP module', () => {
    const hashing = after(step('hash', 'started'), {
      type: 'hash:progress',
      label: 'BK',
      bytes: 23_100_000_000,
      files: 4021,
    });
    assert.deepEqual(hashing.hashed, { bytes: 23_100_000_000, files: 4021 });
    assert.equal(hashing.stageStartedAt.hash, 1000);
    assert.equal(hashing.overall, 'running');

    const decrypting = after(step('hash', 'started'), step('hash', 'done'), step('decrypt', 'started'), {
      type: 'decrypt:progress',
      label: 'BK',
      bytes: 12_400_000_000,
      total: 77_217_764_077,
    });
    assert.deepEqual(decrypting.decrypted, { bytes: 12_400_000_000, total: 77_217_764_077 });
    assert.deepEqual([decrypting.stages.hash, decrypting.stages.decrypt], ['done', 'running']);
    assert.equal(decrypting.stageStartedAt.decrypt, 3000, 'the decrypt started when its event said so');

    const reading = after(step('ileapp', 'started'), {
      type: 'ileapp:module',
      label: 'BK',
      index: 212,
      total: 540,
      module: 'Biome App Intents',
    });
    assert.deepEqual(reading.ileappModule, { index: 212, total: 540, name: 'Biome App Intents', startedAt: 2000 });
  });

  it('marks a failed step and the backup with the reason, and a skipped step as skipped', () => {
    const failed = after(
      step('hash', 'started'),
      step('hash', 'done'),
      step('decrypt', 'skipped', { reason: 'already done' }),
      step('ileapp', 'started'),
      step('ileapp', 'error', { reason: 'iLEAPP exited with code 1' }),
      {
        type: 'backup:finished',
        label: 'BK',
        success: false,
        failed_step: 'ileapp',
        reason: 'iLEAPP exited with code 1',
      }
    );
    assert.deepEqual([failed.stages.decrypt, failed.stages.ileapp], ['skipped', 'error']);
    assert.equal(failed.overall, 'failed');
    assert.equal(failed.errorMessage, 'iLEAPP exited with code 1');
  });

  it('finishes a backup only on its backup:finished, and ignores another backup', () => {
    const done = after(step('hash', 'started'), step('hash', 'done'), {
      type: 'backup:finished',
      label: 'BK',
      success: true,
    });
    assert.equal(done.overall, 'done');
    const other = after({ type: 'backup:step', label: 'OTHER', step: 'hash', status: 'started' });
    assert.equal(other.overall, 'queued');
  });
});

describe('PrepareSession', () => {
  function session() {
    const sent: PrepareState[] = [];
    return { sent, prepare: new PrepareSession((state) => sent.push(state)) };
  }

  it('keeps progress, a pending password, its log and the result for a page that mounts later', () => {
    const { prepare } = session();
    prepare.start('/home/x/Downloads', '/home/x/verichron-workspace', ['BK'], 1000);
    prepare.logFile('prepare-2026-10-18T153002Z-1f3a9c2e.ndjson');
    prepare.entry(entry(1, 'Prepare Evidence started for 1 backup'));
    prepare.follow(event({ type: 'backup:step', label: 'BK', step: 'hash', status: 'started' }), 2000);
    prepare.passwordRequested('BK');

    const mid = prepare.snapshot();
    assert.equal(mid.status, 'running');
    assert.equal(mid.passwordFor, 'BK');
    assert.equal(mid.taskLog, 'prepare-2026-10-18T153002Z-1f3a9c2e.ndjson');
    assert.equal(mid.progress?.byLabel.BK.stages.hash, 'running');
    assert.deepEqual(
      mid.log.map((l) => l.message),
      ['Prepare Evidence started for 1 backup']
    );

    prepare.passwordSubmitted();
    prepare.finish({ success: true, exitCode: 0, workspace: '/home/x/verichron-workspace' });
    const done = prepare.snapshot();
    assert.equal(done.status, 'finished');
    assert.equal(done.passwordFor, null);
    assert.equal(done.result?.success, true);
    assert.equal(done.log.length, 1, 'the log stays with the finished run');
  });

  it('sends a change at once for a start, a password and a finish, without the log', () => {
    const { prepare, sent } = session();
    prepare.start('/s', '/w', ['BK'], 1000);
    prepare.passwordRequested('BK');
    prepare.finish({ success: false, error: 'x' });
    assert.deepEqual(
      sent.map((s) => [s.status, s.passwordFor]),
      [
        ['running', null],
        ['running', 'BK'],
        ['finished', null],
      ]
    );
    assert.ok(sent.every((s) => s.log.length === 0));
  });

  it('keeps the most recent entries for a page that mounts mid-run; the saved log keeps all', () => {
    const { prepare } = session();
    prepare.start('/s', '/w', ['BK']);
    for (let i = 1; i <= KEPT_LOG_LINES + 5; i++) prepare.entry(entry(i, `line ${i}`));
    const log = prepare.snapshot().log;
    assert.equal(log.length, KEPT_LOG_LINES);
    assert.equal(log[0].message, 'line 6');

    prepare.start('/s', '/w', ['BK']);
    assert.equal(prepare.snapshot().log.length, 0, 'a new run starts a new log');
    assert.equal(prepare.snapshot().taskLog, null);
  });
});

describe('AnalysisSession', () => {
  const RUN = '33333333-3333-3333-3333-333333333333';

  it('records whether a run is a workspace analysis or one retried backup, and its workspace', () => {
    const analysis = new AnalysisSession(() => {});
    analysis.start('retry', 'run-123', '/w', 1000);
    analysis.entry(entry(1, 'Analyze started for 1 backup'));
    assert.deepEqual(
      (({ status, kind, target, workspace }) => ({ status, kind, target, workspace }))(analysis.snapshot()),
      { status: 'running', kind: 'retry', target: 'run-123', workspace: '/w' }
    );
    analysis.finish({ success: true });
    assert.equal(analysis.snapshot().status, 'finished');
    assert.equal(analysis.snapshot().log.length, 1);
  });

  it('tracks the running stage and the runs created from events, and clears the stage at completion (EPOCH-443)', () => {
    const analysis = new AnalysisSession(() => {});
    analysis.start('workspace', '/w', '/w', 1000);
    analysis.follow(event({ type: 'run:created', run_id: RUN, evidence_id: RUN, derivative_id: RUN }));
    analysis.follow(event({ type: 'stage:started', run_id: RUN, stage: 'ileapp_bridge' }), 2500);
    assert.deepEqual(analysis.snapshot().currentStage, { name: 'ileapp_bridge', startedAt: 2500 });
    assert.equal(analysis.hasActiveStage(), true);

    analysis.follow(
      event({
        type: 'stage:finished',
        run_id: RUN,
        stage: 'ileapp_bridge',
        status: 'succeeded',
        parser_version: 5,
        derivative_id: RUN,
      }),
      3500
    );
    assert.equal(analysis.snapshot().currentStage, null);
    assert.deepEqual(analysis.runIds(), [RUN]);

    analysis.follow(event({ type: 'stage:started', run_id: RUN, stage: 'reporting' }), 4000);
    analysis.finish({ success: false });
    assert.equal(analysis.snapshot().currentStage, null);
    assert.equal(analysis.snapshot().log.length, 0, 'following an event adds no entry; the task log does');
  });
});

describe('PullLogSession (EPOCH-436)', () => {
  it("keeps the pull's log for a page that mounts mid-pull, and says when it ended", () => {
    const sent: PullLogState[] = [];
    const pull = new PullLogSession((state) => sent.push(state));
    pull.start('/home/x/verichron-workspace', 1000);
    pull.logFile('pull-2026-10-18T142446Z-1f3a9c2e.ndjson');
    pull.entry(entry(1, 'iPhone pull started for iPhone17,5, iOS 26.6.1'));
    const mid = pull.snapshot();
    assert.deepEqual(
      [mid.status, mid.startedAt, mid.taskLog, mid.workspace],
      ['running', 1000, 'pull-2026-10-18T142446Z-1f3a9c2e.ndjson', '/home/x/verichron-workspace']
    );
    assert.deepEqual(
      mid.log.map((l) => l.message),
      ['iPhone pull started for iPhone17,5, iOS 26.6.1']
    );
    pull.finish();
    assert.equal(pull.snapshot().status, 'finished');
    assert.ok(
      sent.every((state) => state.log.length === 0),
      'changes are sent without the log'
    );
  });
});

describe('PullLogSession.reset', () => {
  it('leaves no trace of a pull that never started', () => {
    const pull = new PullLogSession(() => undefined);
    pull.start('/home/x/verichron-workspace', 1000);
    pull.entry(entry(1, 'iPhone pull started'));
    pull.reset();
    assert.deepEqual(pull.snapshot(), { status: 'idle', startedAt: null, taskLog: null, workspace: null, log: [] });
  });
});

describe('LineSplitter', () => {
  it('keeps a character split across chunks whole, and returns what is left at the end', () => {
    const splitter = new LineSplitter();
    const bytes = Buffer.from('noté\nlast', 'utf8');
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    assert.deepEqual(splitter.push(bytes.subarray(0, split)), []);
    assert.deepEqual(splitter.push(bytes.subarray(split)), ['noté']);
    assert.equal(splitter.end(), 'last');
  });
});
