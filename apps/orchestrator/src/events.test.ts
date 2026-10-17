/**
 * EPOCH-443: the event line format and the stage-output relay, without a
 * database. The run loop's events are tested against real Postgres in
 * registration.test.ts.
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { PIPELINE_EVENT_PREFIX, parsePipelineEventLine, renderPipelineEvent } from '@verichron/contracts';

import { emitEvent, relayStageOutput } from './events.js';

const RUN = '33333333-3333-3333-3333-333333333333';
const AT = new Date('2026-10-17T22:00:00.000Z');

describe('event lines', () => {
  it('renders one prefixed JSON line with its envelope, and parses it back', () => {
    const line = renderPipelineEvent({ type: 'stage:started', run_id: RUN, stage: 'crash' }, AT);
    assert.equal(
      line,
      `${PIPELINE_EVENT_PREFIX}{"v":1,"at":"2026-10-17T22:00:00.000Z","type":"stage:started","run_id":"${RUN}","stage":"crash"}`
    );
    assert.deepEqual(parsePipelineEventLine(line), {
      kind: 'event',
      event: { type: 'stage:started', run_id: RUN, stage: 'crash', v: 1, at: '2026-10-17T22:00:00.000Z' },
    });
  });

  it('refuses to render an event the contract would reject', () => {
    assert.throws(() =>
      renderPipelineEvent({ type: 'run:finished', run_id: RUN, state: 'done' as unknown as 'complete' }, AT)
    );
    assert.throws(() => renderPipelineEvent({ type: 'stage:started', run_id: 'not-a-uuid', stage: 'crash' }, AT));
  });

  it('reads a line without the prefix as an ordinary log line', () => {
    assert.deepEqual(parsePipelineEventLine('[orchestrator] stage started: crash'), { kind: 'log' });
    assert.deepEqual(parsePipelineEventLine(`[stage x] ${PIPELINE_EVENT_PREFIX}{}`), { kind: 'log' });
  });

  it('never trusts a prefixed line that is not a valid event', () => {
    const cases = [
      `${PIPELINE_EVENT_PREFIX}not json`,
      `${PIPELINE_EVENT_PREFIX}{"v":1,"at":"2026-10-17T22:00:00Z","type":"run:deleted","run_id":"${RUN}"}`,
      `${PIPELINE_EVENT_PREFIX}{"v":2,"at":"2026-10-17T22:00:00Z","type":"stage:started","run_id":"${RUN}","stage":"x"}`,
      `${PIPELINE_EVENT_PREFIX}{"v":1,"at":"2026-10-17T22:00:00Z","type":"stage:started","run_id":"${RUN}","stage":"x","extra":1}`,
    ];
    for (const line of cases) assert.equal(parsePipelineEventLine(line).kind, 'invalid', line);
  });

  it('emits an event as its own line', () => {
    const out = new PassThrough();
    let text = '';
    out.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    emitEvent({ type: 'run:skipped', evidence_id: RUN, reason: 'already complete' }, out);
    assert.ok(text.startsWith(PIPELINE_EVENT_PREFIX) && text.endsWith('\n') && text.split('\n').length === 2);
  });
});

describe('the stage-output relay', () => {
  async function relayed(chunks: Buffer[]): Promise<string> {
    const relay = relayStageOutput('crash');
    let text = '';
    relay.on('data', (chunk: Buffer | string) => (text += chunk.toString()));
    const ended = new Promise((resolve) => relay.on('end', resolve));
    for (const chunk of chunks) relay.write(chunk);
    relay.end();
    await ended;
    return text;
  }

  it('passes ordinary lines through unchanged, across chunk boundaries and split characters', async () => {
    const bytes = Buffer.from('a line\nnoté\nlast, without a newline', 'utf8');
    const split = bytes.indexOf(Buffer.from('é')) + 1; // inside the two-byte é
    assert.equal(
      await relayed([bytes.subarray(0, split), bytes.subarray(split)]),
      'a line\nnoté\nlast, without a newline'
    );
  });

  it("tags a stage's line that starts with the event prefix, so it can't pass for an event", async () => {
    const forged = renderPipelineEvent({ type: 'run:finished', run_id: RUN, state: 'complete' }, AT);
    const text = await relayed([Buffer.from(`before\n${forged}\n${forged}`)]);
    const lines = text.split('\n');
    assert.deepEqual(lines, ['before', `[stage crash] ${forged}`, `[stage crash] ${forged}`]);
    for (const line of lines) assert.notEqual(parsePipelineEventLine(line).kind, 'event');
  });
});
