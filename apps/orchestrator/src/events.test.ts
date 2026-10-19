/**
 * EPOCH-443: the event line format and the stage-output relay, without a
 * database. The run loop's events are tested against real Postgres in
 * registration.test.ts.
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';

import {
  PIPELINE_EVENT_PREFIX,
  STAGE_REPORT_PREFIX,
  parsePipelineEventLine,
  renderPipelineEvent,
} from '@verichron/contracts';

import { emitEvent, relayStageOutput, setOutputMode, stageReportEvent } from './events.js';

const RUN = '33333333-3333-3333-3333-333333333333';
const AT = new Date('2026-10-17T22:00:00.000Z');

describe('event lines', () => {
  it('renders one prefixed JSON line with its envelope, and parses it back', () => {
    const line = renderPipelineEvent({ type: 'stage:started', run_id: RUN, stage: 'crash' }, AT);
    assert.equal(
      line,
      `${PIPELINE_EVENT_PREFIX}{"v":1,"at":"2026-10-17T22:00:00.000Z","type":"stage:started","run_id":"${RUN}","stage":"crash"}`
    );
    assert.deepEqual(parsePipelineEventLine(line, 'orchestrator'), {
      kind: 'event',
      event: { type: 'stage:started', run_id: RUN, stage: 'crash', v: 1, at: '2026-10-17T22:00:00.000Z' },
    });
  });

  it('refuses to render an event the contract would reject', () => {
    assert.throws(() =>
      renderPipelineEvent({ type: 'run:finished', run_id: RUN, label: 'L', state: 'done' as unknown as 'complete' }, AT)
    );
    assert.throws(() => renderPipelineEvent({ type: 'stage:started', run_id: 'not-a-uuid', stage: 'crash' }, AT));
  });

  it('reads a line without the prefix as an ordinary log line', () => {
    assert.deepEqual(parsePipelineEventLine('[orchestrator] stage started: crash', 'orchestrator'), { kind: 'log' });
    assert.deepEqual(parsePipelineEventLine(`[stage x] ${PIPELINE_EVENT_PREFIX}{}`, 'orchestrator'), { kind: 'log' });
  });

  it('never trusts a prefixed line that is not a valid event', () => {
    const cases = [
      `${PIPELINE_EVENT_PREFIX}not json`,
      `${PIPELINE_EVENT_PREFIX}{"v":1,"at":"2026-10-17T22:00:00Z","type":"run:deleted","run_id":"${RUN}"}`,
      `${PIPELINE_EVENT_PREFIX}{"v":2,"at":"2026-10-17T22:00:00Z","type":"stage:started","run_id":"${RUN}","stage":"x"}`,
      `${PIPELINE_EVENT_PREFIX}{"v":1,"at":"2026-10-17T22:00:00Z","type":"stage:started","run_id":"${RUN}","stage":"x","extra":1}`,
    ];
    for (const line of cases) assert.equal(parsePipelineEventLine(line, 'orchestrator').kind, 'invalid', line);
  });

  it('emits an event as its own line, for the app', () => {
    setOutputMode('events');
    const out = new PassThrough();
    let text = '';
    out.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    emitEvent({ type: 'run:skipped', evidence_id: RUN, label: 'L', reason: 'already complete' }, out);
    assert.ok(text.startsWith(PIPELINE_EVENT_PREFIX) && text.endsWith('\n') && text.split('\n').length === 2);
    setOutputMode('text');
  });

  it('writes the same event as its sentence on the command line, an error on stderr', () => {
    setOutputMode('text');
    const out = new PassThrough();
    const err = new PassThrough();
    let outText = '';
    let errText = '';
    out.on('data', (chunk: Buffer) => (outText += chunk.toString('utf8')));
    err.on('data', (chunk: Buffer) => (errText += chunk.toString('utf8')));
    emitEvent({ type: 'run:skipped', evidence_id: RUN, label: 'L', reason: 'already complete' }, out, err);
    emitEvent({ type: 'log', level: 'error', message: 'the database went away' }, out, err);
    assert.equal(outText, '[orchestrator] Not analyzed again: already complete\n');
    assert.equal(errText, '[orchestrator] error: the database went away\n');
  });
});

describe('the stage-output relay', () => {
  after(() => setOutputMode('text'));

  async function relayed(chunks: Buffer[], stream: 'stdout' | 'stderr' = 'stdout'): Promise<string> {
    const relay = relayStageOutput('crash', stream);
    let text = '';
    relay.on('data', (chunk: Buffer | string) => (text += chunk.toString()));
    const ended = new Promise((resolve) => relay.on('end', resolve));
    for (const chunk of chunks) relay.write(chunk);
    relay.end();
    await ended;
    return text;
  }

  it('passes ordinary lines through unchanged on the command line, across chunk boundaries and split characters', async () => {
    setOutputMode('text');
    const bytes = Buffer.from('a line\nnoté\nlast\n', 'utf8');
    const split = bytes.indexOf(Buffer.from('é')) + 1; // inside the two-byte é
    assert.equal(await relayed([bytes.subarray(0, split), bytes.subarray(split)]), 'a line\nnoté\nlast\n');
  });

  it("ends a stage's last line when the stage didn't, so the next line starts on its own (EPOCH-435)", async () => {
    setOutputMode('text');
    assert.equal(await relayed([Buffer.from('a line\ndone')]), 'a line\ndone\n');
    assert.equal(await relayed([]), '', 'a stage that printed nothing adds nothing');
  });

  it("makes each line a stage:output event for the app, so a forged event line is only a stage's text (EPOCH-570)", async () => {
    setOutputMode('events');
    const forged = renderPipelineEvent({ type: 'run:finished', run_id: RUN, label: 'L', state: 'complete' }, AT);
    const text = await relayed([Buffer.from(`before\n${forged}\n${forged}`)], 'stderr');
    const parsed = text
      .split('\n')
      .filter(Boolean)
      .map((line) => parsePipelineEventLine(line, 'orchestrator'));
    assert.deepEqual(
      parsed.map((p) => (p.kind === 'event' && p.event.type === 'stage:output' ? [p.event.stream, p.event.line] : p)),
      [
        ['stderr', 'before'],
        ['stderr', forged],
        ['stderr', forged],
      ],
      'every line, the unended last one included, is its own stage:output event'
    );
  });
});

describe('stage reports (EPOCH-570)', () => {
  after(() => setOutputMode('text'));
  const reportLine = (body: object) => `${STAGE_REPORT_PREFIX}${JSON.stringify(body)}`;

  it("reads a stage's report as its stage:log, naming the stage the orchestrator ran", () => {
    assert.deepEqual(
      stageReportEvent('indicator_match', reportLine({ v: 1, level: 'info', message: 'x', index: 1, total: 9 })),
      {
        type: 'stage:log',
        stage: 'indicator_match',
        level: 'info',
        message: 'x',
        index: 1,
        total: 9,
      }
    );
    assert.equal(
      stageReportEvent('crash', reportLine({ v: 1, level: 'info', message: 'x', stage: 'reporting' })),
      null,
      'a stage never names itself'
    );
    assert.equal(stageReportEvent('crash', reportLine({ v: 1, level: 'loud', message: 'x' })), null);
    assert.equal(
      stageReportEvent('crash', reportLine({ v: 1, level: 'info', message: 'x', review: true })),
      null,
      "the event's own rules apply: a note for review is a warn"
    );
    assert.equal(stageReportEvent('crash', 'plain output'), null);
  });

  it('relays a report as its event, and an unreadable one as output with a warning', async () => {
    setOutputMode('events');
    const relay = relayStageOutput('crash', 'stdout');
    let text = '';
    relay.on('data', (chunk: Buffer | string) => (text += chunk.toString()));
    const ended = new Promise((resolve) => relay.on('end', resolve));
    relay.end(
      Buffer.from(
        `${reportLine({ v: 1, level: 'warn', message: 'kept for review', review: true })}\n${reportLine({ v: 1 })}\n`
      )
    );
    await ended;
    const events = text
      .split('\n')
      .filter(Boolean)
      .map((line) => parsePipelineEventLine(line, 'orchestrator'))
      .map((p) => (p.kind === 'event' ? p.event.type : p.kind));
    assert.deepEqual(events, ['stage:log', 'stage:output', 'log']);
  });
});
