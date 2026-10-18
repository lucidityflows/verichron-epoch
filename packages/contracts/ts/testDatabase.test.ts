/** TEST_DATABASE_URL is refused unless it names a test database (2026-10-18, EPOCH-570). */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { safeTestDatabaseUrl, unsafeTestDatabase } from './testDatabase.js';

const saved = { url: process.env.TEST_DATABASE_URL, name: process.env.DB_NAME };
afterEach(() => {
  process.env.TEST_DATABASE_URL = saved.url;
  process.env.DB_NAME = saved.name;
  if (saved.url === undefined) delete process.env.TEST_DATABASE_URL;
  if (saved.name === undefined) delete process.env.DB_NAME;
});

describe('the test database guard', () => {
  it('accepts a database named as a test one', () => {
    for (const name of ['verichron_test', 'verichron_ci', 'epoch-test']) {
      assert.equal(unsafeTestDatabase(`postgresql://u:p@localhost:5432/${name}`), null, name);
    }
  });

  it('refuses the dev database, and a database not named as a test one', () => {
    process.env.DB_NAME = 'epoch-vault';
    assert.match(unsafeTestDatabase('postgresql://u:p@localhost:5432/epoch-vault')!, /the one \.env names/);
    assert.match(unsafeTestDatabase('postgresql://u:p@localhost:5432/latest')!, /not named as a test database/);
    assert.match(unsafeTestDatabase('postgresql://u:p@localhost:5432/')!, /names no database/);
  });

  it('throws before a test can use a refused URL', () => {
    process.env.DB_NAME = 'epoch-vault';
    process.env.TEST_DATABASE_URL = 'postgresql://u:p@localhost:5432/epoch-vault';
    assert.throws(() => safeTestDatabaseUrl(), /refused/);
  });
});
