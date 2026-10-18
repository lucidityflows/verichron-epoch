/** The test database guard gives the shared cases' results (2026-10-18, EPOCH-570, R4). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { databaseRefusal, devDatabaseFromEnv, safeTestDatabaseUrl } from './testDatabase.js';

// The same cases the Python guard's tests read (scripts/test_pg_real_guard.py).
const vectors = JSON.parse(readFileSync(path.resolve(__dirname, '../test-database-vectors.json'), 'utf8')) as {
  urls: { dsn: string; dev: string | null; refused: string | null }[];
  env: { text: string; dev: string | null }[];
};

const saved = process.env.TEST_DATABASE_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = saved;
});

describe('the test database guard', () => {
  for (const c of vectors.urls) {
    it(`gives ${c.refused ?? 'accepted'} for ${c.dsn}`, () => {
      assert.equal(databaseRefusal(c.dsn, c.dev)?.code ?? null, c.refused);
    });
  }

  for (const c of vectors.env) {
    it(`reads the dev database from .env: ${JSON.stringify(c.text)}`, () => {
      assert.equal(devDatabaseFromEnv(c.text), c.dev);
    });
  }

  it('throws before a test can use a refused URL', () => {
    process.env.TEST_DATABASE_URL = 'postgresql://u:p@localhost:5432/latest';
    assert.throws(() => safeTestDatabaseUrl(), /refused/);
  });
});
