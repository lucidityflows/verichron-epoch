/**
 * EPOCH-487: Prepare Evidence and Analyze keep their state in the main
 * process, so New Investigation can be left and opened again mid-run.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

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
    analysis.start('retry', '/w/decrypted/BK', 1000);
    analysis.line('stdout', 'retrying');
    assert.deepEqual((({ status, kind, target }) => ({ status, kind, target }))(analysis.snapshot()), {
      status: 'running',
      kind: 'retry',
      target: '/w/decrypted/BK',
    });
    analysis.finish({ success: true });
    assert.equal(analysis.snapshot().status, 'finished');
    assert.equal(analysis.snapshot().log.length, 1);
  });

  it('tracks stage start time from orchestrator lifecycle lines and clears it at completion', () => {
    const analysis = new AnalysisSession(() => {});
    analysis.start('workspace', '/w', 1000);
    analysis.line('stdout', '[orchestrator] stage started: ileapp_bridge', 2500);
    assert.deepEqual(analysis.snapshot().currentStage, { name: 'ileapp_bridge', startedAt: 2500 });
    assert.equal(analysis.hasActiveStage(), true);

    analysis.line('stdout', '[orchestrator] stage finished: ileapp_bridge', 3500);
    assert.equal(analysis.snapshot().currentStage, null);
    assert.equal(analysis.hasActiveStage(), false);

    analysis.line('stdout', '[orchestrator] stage started: reporting', 4000);
    analysis.finish({ success: false });
    assert.equal(analysis.snapshot().currentStage, null);
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
