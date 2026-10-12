/**
 * EPOCH-406: a decrypt's repair provenance must account for every original it
 * preserved, even when a step after the copy fails. EPOCH-486: recovery streams
 * the recovered SQL, so a large database or a sqlite3 that stops reading can't
 * end the processor. Uses stub sqlite3s that report every database as
 * malformed and "recover" it.
 */

import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { Config } from './cli.js';
import { repairDecrypted } from './repair.js';

let tmp: string;
let sqlite: string;

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'repair-'));
  // -version              -> a version line
  // <db> "PRAGMA ..."     -> "not ok" (every database is malformed)
  // <db> .recover         -> some SQL
  // <new db>  (SQL stdin) -> creates <new db>
  sqlite = path.join(tmp, 'sqlite3-stub');
  writeFileSync(
    sqlite,
    `#!/bin/sh
if [ "$1" = -version ]; then echo "3.99.0 2026-10-08 stub"; exit 0; fi
case "$2" in
  "PRAGMA quick_check;") echo "not ok" ;;
  .recover) echo "CREATE TABLE t(x);" ;;
  "") cat > /dev/null; touch "$1" ;;
esac
exit 0
`
  );
  chmodSync(sqlite, 0o755);
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function sqliteFile(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([Buffer.from('SQLite format 3\0', 'ascii'), Buffer.alloc(84)]));
}

describe('repair provenance', () => {
  it('records an original preserved before a later step failed', async () => {
    const decDir = path.join(tmp, 'decrypted');
    const db = path.join(decDir, 'HomeDomain', 'sms.db');
    sqliteFile(db);
    // Removing a stale "-wal" fails when it is a directory: the step after
    // the copy and the rename throws, as a real cleanup failure would.
    mkdirSync(`${db}-wal`);
    writeFileSync(path.join(`${db}-wal`, 'keep'), '');

    const repair = await repairDecrypted({ sqliteBin: sqlite } as Config, decDir);

    assert.equal(repair.status, 'ran');
    if (repair.status !== 'ran') return;
    assert.deepEqual(repair.tool, { name: 'sqlite3', version: '3.99.0' });
    assert.deepEqual(repair.failed_files, ['HomeDomain/sms.db'], 'the failure is recorded');
    assert.equal(repair.preserved_originals.length, 1, 'and so is the original it had already preserved');
    assert.match(repair.preserved_originals[0], /^HomeDomain\/sms\.db\.corrupt-/);
    assert.ok(existsSync(path.join(decDir, repair.preserved_originals[0])));
  });
});

/** A stub sqlite3: a version, "not ok" for every quick_check, and `recover` / `apply` for the two halves of recovery. */
function stubSqlite(name: string, recover: string, apply: string): string {
  const bin = path.join(tmp, name);
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = -version ]; then echo "3.99.0 2026-10-08 stub"; exit 0; fi
case "$2" in
  "PRAGMA quick_check;") echo "not ok" ;;
  .recover) ${recover} ;;
  "") ${apply} ;;
esac
exit 0
`
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe('streamed recovery (EPOCH-486)', () => {
  it('passes recovered SQL longer than V8 can hold in one string straight to sqlite3', async () => {
    // 600 MB: past V8's longest string (about 512 MB), which the old in-memory recovery would have thrown on.
    const bytes = 600_000_000;
    const sqlite = stubSqlite(
      'sqlite3-large',
      `yes "INSERT INTO t VALUES(1);" | head -c ${bytes}`,
      'wc -c | tr -d " " > "$1"'
    );
    const decDir = path.join(tmp, 'large');
    const db = path.join(decDir, 'HomeDomain', 'big.db');
    sqliteFile(db);

    const repair = await repairDecrypted({ sqliteBin: sqlite } as Config, decDir);

    assert.equal(repair.status, 'ran');
    if (repair.status !== 'ran') return;
    // The stub's "repaired" database holds the byte count it read, so every byte arrived.
    assert.equal(readFileSync(db, 'utf8').trim(), String(bytes));
    assert.equal(repair.preserved_originals.length, 1);
  });

  it('fails the database, not the processor, when sqlite3 stops reading the recovered SQL', async () => {
    const sqlite = stubSqlite(
      'sqlite3-closes',
      'yes "INSERT INTO t VALUES(1);" | head -c 50000000',
      'exec 0<&-; exit 1'
    );
    const decDir = path.join(tmp, 'closes');
    const db = path.join(decDir, 'HomeDomain', 'sms.db');
    sqliteFile(db);

    const repair = await repairDecrypted({ sqliteBin: sqlite } as Config, decDir);

    assert.equal(repair.status, 'ran');
    if (repair.status !== 'ran') return;
    assert.deepEqual(repair.failed_files, ['HomeDomain/sms.db']);
    assert.deepEqual(repair.preserved_originals, [], 'nothing was replaced');
    assert.equal(
      readdirSync(path.dirname(db)).filter((f) => f.includes('.repaired-')).length,
      0,
      'no partial file left'
    );
  });
});
