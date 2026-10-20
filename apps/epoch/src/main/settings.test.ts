/** The examiner's settings (EPOCH-560): kept in one file, so they survive a restart, and never guessed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { DEFAULT_SETTINGS, SETTINGS_FILE, readSettings, updateSettings } from './settings';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-settings-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const write = (text: string) => fs.writeFileSync(path.join(tmp, SETTINGS_FILE), text);

describe('settings', () => {
  it('are the defaults before anything is chosen: times in UTC, no remembered folder', async () => {
    assert.deepEqual(await readSettings(tmp), { displayZone: 'UTC', backupsFolder: null });
    assert.deepEqual(DEFAULT_SETTINGS, { displayZone: 'UTC', backupsFolder: null });
  });

  it('keep a chosen zone and folder in the file, so a restart reads them back', async () => {
    await updateSettings(tmp, { displayZone: 'America/Chicago' });
    await updateSettings(tmp, { backupsFolder: '/cases/backups' });
    // A new process reads only the file.
    assert.deepEqual(await readSettings(tmp), { displayZone: 'America/Chicago', backupsFolder: '/cases/backups' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, SETTINGS_FILE), 'utf8')), {
      displayZone: 'America/Chicago',
      backupsFolder: '/cases/backups',
    });
  });

  it('refuse a zone that is not UTC or a named zone, and leave the file as it was', async () => {
    await updateSettings(tmp, { displayZone: 'Asia/Calcutta' });
    for (const zone of ['CST', '+05:30', 'Etc/GMT+5', 'America/Nowhere', 'america/chicago', 'Asia/Kolkata']) {
      await assert.rejects(updateSettings(tmp, { displayZone: zone }), /displayZone must be UTC or a named time zone/);
    }
    assert.equal((await readSettings(tmp)).displayZone, 'Asia/Calcutta');
  });

  it('refuse a file that cannot be read as settings, naming it, rather than replacing it with the defaults', async () => {
    write('{ not json');
    await assert.rejects(readSettings(tmp), /settings\.json is not valid JSON/);
    write(JSON.stringify({ displayZone: 'UTC', theme: 'dark' }));
    await assert.rejects(readSettings(tmp), /settings Epoch doesn't know: theme/);
    write(JSON.stringify({ displayZone: 'EST' }));
    await assert.rejects(readSettings(tmp), /displayZone must be UTC or a named time zone, not "EST"/);
    write(JSON.stringify({ backupsFolder: 'relative/path' }));
    await assert.rejects(readSettings(tmp), /backupsFolder must be a folder's full path or null/);
    write('[]');
    await assert.rejects(readSettings(tmp), /does not hold settings/);
  });

  it('fill a setting the file leaves out with its default', async () => {
    write(JSON.stringify({ displayZone: 'Europe/London' }));
    assert.deepEqual(await readSettings(tmp), { displayZone: 'Europe/London', backupsFolder: null });
  });
});
