/** The folders device pulls have written to (EPOCH-466). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { addPullDestination, PULL_DESTINATIONS_FILE, pullFolderName, readPullDestinations } from './pullDestinations';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-destinations-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('pull destinations', () => {
  it('is empty before any pull', async () => {
    assert.deepEqual(await readPullDestinations(tmp), []);
  });

  it('keeps the most recent first, without repeats, at most 20', async () => {
    for (let i = 0; i < 25; i++) await addPullDestination(tmp, `/backups/${i}`);
    await addPullDestination(tmp, '/backups/10');
    const list = await readPullDestinations(tmp);
    assert.equal(list.length, 20);
    assert.deepEqual(list.slice(0, 3), ['/backups/10', '/backups/24', '/backups/23']);
    assert.equal(new Set(list).size, 20);
  });

  it('refuses a file that is not a list of folders', async () => {
    fs.writeFileSync(path.join(tmp, PULL_DESTINATIONS_FILE), '{"a":1}');
    await assert.rejects(readPullDestinations(tmp), /not a list of folders/);
  });
});

describe('pullFolderName (EPOCH-504)', () => {
  it('names a pull by its UTC start, sortable and without colons', () => {
    assert.equal(pullFolderName(new Date('2026-10-14T13:05:12.345Z')), '2026-10-14T130512Z');
  });

  it('gives later pulls names that sort later', () => {
    const names = ['2026-10-14T09:00:00Z', '2026-10-14T13:05:12Z', '2027-01-02T00:00:00Z'].map((t) =>
      pullFolderName(new Date(t))
    );
    assert.deepEqual([...names].sort(), names);
  });
});
