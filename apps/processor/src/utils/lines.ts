import { StringDecoder } from 'node:string_decoder';

/**
 * Splits a stream into lines as it arrives, keeping the partial last line for
 * the next chunk. One decoder for the whole stream, so a character split
 * across two chunks (a non-ASCII file name) decodes intact.
 */
export function lineReader(onLine: (line: string) => void): { push: (chunk: Buffer) => void; end: () => void } {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  return {
    push(chunk) {
      const parts = (carry + decoder.write(chunk)).split('\n');
      carry = parts.pop() ?? '';
      parts.forEach(onLine);
    },
    end() {
      const rest = carry + decoder.end();
      carry = '';
      if (rest) onLine(rest);
    },
  };
}
