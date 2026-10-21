/**
 * The renderer runs in the browser: it may take only types from the
 * main-process packages. A value import bundles the package, and `pg` and
 * `dotenv` with it, and the app fails to start ("Buffer is not defined";
 * found 2026-10-21, EPOCH-580). The tests run under Node, where those
 * modules load, so only this check catches it.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'vitest';

const MAIN_ONLY = /^@verichron\/(etl-db-reader|contracts)(\/|$)/;
const ROOTS = [path.join(__dirname), path.join(__dirname, '..', 'shared')];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [full] : [];
  });
}

describe('renderer imports', () => {
  it('takes only types from the main-process packages', () => {
    const offending: string[] = [];
    for (const file of ROOTS.flatMap(sources)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\s+from\s+'([^']+)'/gm)) {
        if (MAIN_ONLY.test(m[3]) && !m[2]) offending.push(`${path.relative(__dirname, file)}: ${m[3]}`);
      }
    }
    assert.deepEqual(offending, []);
  });
});
