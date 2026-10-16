/**
 * EPOCH-451: the TypeScript record type (the Zod mirror in
 * packages/contracts/ts/normalizedRecord.ts) declares the same fields as
 * normalized-record.schema.json, with the same nullability and required-ness,
 * as the Python model is already checked to (test_contract_sync.py). A
 * property added to the schema but not to the Zod shape fails here.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { NormalizedRecord } from '@verichron/contracts';

const CONTRACTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/contracts');
const schema = JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, 'normalized-record.schema.json'), 'utf8')) as {
  required: string[];
  properties: Record<string, { type?: string | string[] }>;
  additionalProperties: boolean;
};
const MINIMAL = { source_type: 'crash_report', fields: {} };
const shape = NormalizedRecord.shape as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;

describe('NormalizedRecord (Zod) against normalized-record.schema.json', () => {
  it('declares exactly the schema properties', () => {
    assert.deepEqual(Object.keys(shape).sort(), Object.keys(schema.properties).sort());
  });

  it('accepts null exactly where the schema allows it', () => {
    for (const [name, property] of Object.entries(schema.properties)) {
      const nullable = Array.isArray(property.type) && property.type.includes('null');
      assert.equal(shape[name].safeParse(null).success, nullable, `${name}: null ${nullable ? 'allowed' : 'refused'}`);
    }
  });

  it('requires what the schema requires, unless it has a default; requires nothing else', () => {
    for (const name of Object.keys(schema.properties)) {
      const { [name]: _, ...without } = MINIMAL as Record<string, unknown>;
      const parsed = NormalizedRecord.safeParse(without);
      const required = schema.required.includes(name);
      const defaulted = parsed.success && (parsed.data as Record<string, unknown>)[name] !== undefined;
      if (required) {
        assert.ok(!parsed.success || defaulted, `${name}: required by the schema, so it must be required or defaulted`);
      } else {
        assert.ok(parsed.success, `${name}: optional in the schema, so a record without it parses`);
      }
    }
  });

  it('refuses a property the schema does not declare, as additionalProperties: false does', () => {
    assert.equal(schema.additionalProperties, false);
    assert.equal(NormalizedRecord.safeParse({ ...MINIMAL, smuggled: 1 }).success, false);
  });
});
