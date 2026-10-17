/**
 * EPOCH-487: Prepare Evidence and Analyze keep their state in the main
 * process, so New Investigation can be left and opened again mid-run.
 */
import assert from 'node:assert/strict';
import { PIPELINE_EVENT_PREFIX, renderPipelineEvent, type PipelineEventBody } from '@verichron/contracts';
import { describe, it, vi } from 'vitest';

import { applyPrepareLogLine, initPrepareProgress } from '../../shared/prepareProgress';
import type { PrepareState } from '../../shared/types/window';
import { AnalysisSession, KEPT_LOG_LINES, LineSplitter, PrepareSession } from './pipelineSessions';

describe('prepare progress lines', () => {
  const lines = (...text: string[]) => {
    let state = initPrepareProgress(['BK']);
    text.forEach((line, i) => (state = applyPrepareLogLine(state, line, 1000 * (i + 1))));
    return state.byLabel.BK;
  };

  it('reads bytes hashed, bytes decrypted and the iLEAPP module', () => {
    const hashing = lines('=== BK ===', '  [hash]    progress 23100000000 bytes, 4021 files');
    assert.deepEqual(hashing.hashed, { bytes: 23_100_000_000, files: 4021 });
    assert.equal(hashing.stageStartedAt.hash, 1000);

    const decrypting = lines(
      '=== BK ===',
      '  [hash]    done -> x',
      '  [decrypt] progress 12400000000 of 77217764077 bytes'
    );
    assert.deepEqual(decrypting.decrypted, { bytes: 12_400_000_000, total: 77_217_764_077 });
    assert.equal(decrypting.stages.decrypt, 'running');
    assert.equal(decrypting.stageStartedAt.decrypt, 2000, 'the decrypt started when the hash finished');

    const reading = lines('=== BK ===', '  [ileapp]  module 212 of 540: Biome App Intents');
    assert.deepEqual(reading.ileappModule, { index: 212, total: 540, name: 'Biome App Intents', startedAt: 2000 });
  });

  it('leaves a step running on a progress line', () => {
    const state = lines('=== BK ===', '  [hash]    progress 5 bytes, 1 files');
    assert.equal(state.stages.hash, 'running');
    assert.equal(state.overall, 'running');
  });
});

describe('PrepareSession', () => {
  function session() {
    const sent: PrepareState[] = [];
    return { sent, prepare: new PrepareSession((state) => sent.push(state)) };
  }

  it('keeps progress, a pending password and the result for a page that mounts later', () => {
    const { prepare } = session();
    prepare.start('/home/x/Downloads', '/home/x/verichron-workspace', ['BK'], 1000);
    prepare.line('stdout', '=== BK ===', 2000);
    prepare.line('stdout', '  [hash]    done -> x', 3000);
    prepare.passwordRequested('BK');

    const mid = prepare.snapshot();
    assert.equal(mid.status, 'running');
    assert.equal(mid.passwordFor, 'BK');
    assert.equal(mid.progress?.byLabel.BK.stages.decrypt, 'running');
    assert.deepEqual(
      mid.log.map((l) => l.line),
      ['=== BK ===', '  [hash]    done -> x']
    );

    prepare.passwordSubmitted();
    prepare.finish({ success: true, exitCode: 0, workspace: '/home/x/verichron-workspace' });
    const done = prepare.snapshot();
    assert.equal(done.status, 'finished');
    assert.equal(done.passwordFor, null);
    assert.equal(done.result?.success, true);
    assert.equal(done.log.length, 2, 'the log stays with the finished run');
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

  it('keeps the most recent lines, numbered across runs so none is shown twice', () => {
    const { prepare } = session();
    prepare.start('/s', '/w', ['BK']);
    for (let i = 0; i < KEPT_LOG_LINES + 5; i++) prepare.line('stdout', `line ${i}`);
    const log = prepare.snapshot().log;
    assert.equal(log.length, KEPT_LOG_LINES);
    assert.equal(log[0].line, 'line 5');
    const lastSeq = log[log.length - 1].seq;

    prepare.start('/s', '/w', ['BK']);
    assert.equal(prepare.snapshot().log.length, 0, 'a new run starts a new log');
    assert.ok(prepare.line('stdout', 'next run').seq > lastSeq);
  });
});

describe('AnalysisSession', () => {
  it('records whether a run is a workspace analysis or one retried backup', () => {
    const analysis = new AnalysisSession(() => {});
    analysis.start('retry', 'run-123', 1000);
    analysis.line('stdout', 'retrying');
    assert.deepEqual((({ status, kind, target }) => ({ status, kind, target }))(analysis.snapshot()), {
      status: 'running',
      kind: 'retry',
      target: 'run-123',
    });
    analysis.finish({ success: true });
    assert.equal(analysis.snapshot().status, 'finished');
    assert.equal(analysis.snapshot().log.length, 1);
  });

  const RUN = '33333333-3333-3333-3333-333333333333';
  const event = (body: PipelineEventBody) => renderPipelineEvent(body);

  it('tracks the running stage from orchestrator events and clears it at completion (EPOCH-443)', () => {
    const analysis = new AnalysisSession(() => {});
    analysis.start('workspace', '/w', 1000);
    assert.equal(
      analysis.line('stdout', event({ type: 'stage:started', run_id: RUN, stage: 'ileapp_bridge' }), 2500),
      null
    );
    assert.deepEqual(analysis.snapshot().currentStage, { name: 'ileapp_bridge', startedAt: 2500 });
    assert.equal(analysis.hasActiveStage(), true);

    analysis.line(
      'stdout',
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
    assert.equal(analysis.hasActiveStage(), false);

    analysis.line('stdout', event({ type: 'stage:started', run_id: RUN, stage: 'reporting' }), 4000);
    analysis.finish({ success: false });
    assert.equal(analysis.snapshot().currentStage, null);
    assert.equal(analysis.snapshot().log.length, 0, 'events are not log lines');
  });

  it('takes nothing from human text, only from events', () => {
    const analysis = new AnalysisSession(() => {});
    analysis.start('workspace', '/w', 1000);
    analysis.line('stdout', '[orchestrator] stage started: ileapp_bridge', 2500);
    assert.equal(analysis.snapshot().currentStage, null);
    assert.equal(analysis.snapshot().log.length, 1, 'kept as a log line');
  });

  it('never trusts a prefixed line that is not a valid event: it stays text and changes nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const analysis = new AnalysisSession(() => {});
    analysis.start('workspace', '/w', 1000);
    const forged = `${PIPELINE_EVENT_PREFIX}{"v":1,"type":"run:created","run_id":"${RUN}"}`;
    const entry = analysis.line('stdout', forged, 2500);
    assert.equal(entry?.line, forged);
    assert.deepEqual(analysis.runIds(), []);
    assert.equal(warn.mock.calls.length, 1);
    // A stage's line the orchestrator tagged is ordinary text too.
    analysis.line('stdout', `[stage crash] ${event({ type: 'stage:started', run_id: RUN, stage: 'x' })}`, 2600);
    assert.equal(analysis.snapshot().currentStage, null);
    warn.mockRestore();
  });

  it('records the runs a call created, and forgets them when the next call starts', () => {
    const analysis = new AnalysisSession(() => {});
    analysis.start('workspace', '/w', 1000);
    const other = '44444444-4444-4444-4444-444444444444';
    for (const run_id of [RUN, other]) {
      analysis.line('stdout', event({ type: 'run:created', run_id, evidence_id: run_id, derivative_id: run_id }));
    }
    analysis.line('stderr', event({ type: 'run:created', run_id: RUN, evidence_id: RUN, derivative_id: RUN }));
    assert.deepEqual(analysis.runIds(), [RUN, other], 'only stdout carries events');
    analysis.start('retry', RUN, 2000);
    assert.deepEqual(analysis.runIds(), []);
  });
});

describe('LineSplitter', () => {
  it('keeps a character split across chunks whole, and exposes a prompt without a newline', () => {
    const splitter = new LineSplitter();
    const bytes = Buffer.from('Été\n  password for BK: ', 'utf8');
    assert.deepEqual(splitter.push(bytes.subarray(0, 1)), []);
    assert.deepEqual(splitter.push(bytes.subarray(1)), ['Été']);
    assert.equal(splitter.pending(), '  password for BK: ');
    assert.equal(splitter.takePending(), '  password for BK: ');
    assert.equal(splitter.end(), '');
  });
});
