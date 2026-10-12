import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lineReader } from './lines.js';

describe('lineReader (EPOCH-486)', () => {
  it('decodes a character split across two chunks', () => {
    const lines: string[] = [];
    const reader = lineReader((line) => lines.push(line));
    const bytes = Buffer.from('Failed to decrypt file Photos/Été.jpg: x\nnext', 'utf8');
    const split = bytes.indexOf(0xc3) + 1; // between the two bytes of "É"
    reader.push(bytes.subarray(0, split));
    reader.push(bytes.subarray(split));
    reader.end();
    assert.deepEqual(lines, ['Failed to decrypt file Photos/Été.jpg: x', 'next']);
  });
});
