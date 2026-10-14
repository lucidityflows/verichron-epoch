import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveDatabaseUrl } from '@verichron/contracts';

type DatabaseUrlCase = {
  name: string;
  env: Record<string, string>;
  expectedUrl?: string;
  expectedError?: string;
};

const casesPath = fileURLToPath(
  new URL('../../../packages/contracts/testdata/database_url_cases.json', import.meta.url)
);
const databaseUrlCases = JSON.parse(readFileSync(casesPath, 'utf8')) as DatabaseUrlCase[];
const databaseEnvKeys = ['DATABASE_URL', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_HOST', 'DB_PORT'];

test('database URL resolution matches the shared Python/TypeScript cases', () => {
  const originalEnv = Object.fromEntries(databaseEnvKeys.map((key) => [key, process.env[key]]));

  try {
    for (const testCase of databaseUrlCases) {
      for (const key of databaseEnvKeys) delete process.env[key];
      Object.assign(process.env, testCase.env);

      if (testCase.expectedUrl !== undefined) {
        assert.equal(resolveDatabaseUrl(), testCase.expectedUrl, testCase.name);
      } else {
        assert.throws(() => resolveDatabaseUrl(), { message: testCase.expectedError }, testCase.name);
      }
    }
  } finally {
    for (const key of databaseEnvKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
