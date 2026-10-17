import { StringDecoder } from 'node:string_decoder';
import { Transform, type TransformCallback } from 'node:stream';
import { PIPELINE_EVENT_PREFIX, renderPipelineEvent, type PipelineEventBody } from '@verichron/contracts';

/**
 * Writes one event (EPOCH-443) as its own stdout line. The contract validates
 * it first, so a malformed event is an orchestrator bug that fails here, not
 * a line the app has to doubt.
 */
export function emitEvent(body: PipelineEventBody, out: NodeJS.WritableStream = process.stdout): void {
  out.write(`${renderPipelineEvent(body)}\n`);
}

/**
 * A stage's stdout, relayed onto the orchestrator's line by line. A stage
 * line that starts with the event prefix is tagged with the stage's name, so
 * no stage, and nothing a stage echoes from the evidence, can pass for one of
 * the orchestrator's events: only emitEvent writes an untagged prefixed line.
 */
export function relayStageOutput(stage: string): Transform {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  const relay = (line: string) => (line.startsWith(PIPELINE_EVENT_PREFIX) ? `[stage ${stage}] ${line}` : line);
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      const parts = (carry + decoder.write(chunk)).split('\n');
      carry = parts.pop() ?? '';
      done(null, parts.map((line) => `${relay(line)}\n`).join(''));
    },
    flush(done: TransformCallback) {
      const rest = carry + decoder.end();
      done(null, rest ? relay(rest) : '');
    },
  });
}
