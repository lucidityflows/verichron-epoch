/** The settings' IPC (EPOCH-560): what the renderer may change, and every window told of a change. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const sent: unknown[][] = [];
let userData: string;

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  },
  default: {
    app: { getPath: () => userData },
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
        handlers.set(channel, handler),
    },
  },
}));

import { registerSettingsHandlers } from './settingsHandlers';
import { readSettings } from '../settings';

const invoke = <T>(channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args) as Promise<T>;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-settings-ipc-'));
  handlers.clear();
  sent.length = 0;
  const window = { webContents: { send: (...args: unknown[]) => sent.push(args) } };
  registerSettingsHandlers(() => window as never);
});

afterEach(() => fs.rmSync(userData, { recursive: true, force: true }));

describe('settings IPC', () => {
  it('saves a chosen zone, tells every window, and refuses one that is not UTC or a named zone', async () => {
    const saved = await invoke('epoch:setDisplayZone', 'America/Chicago');
    assert.deepEqual(saved, { displayZone: 'America/Chicago', backupsFolder: null });
    assert.deepEqual(sent, [['epoch:settingsChanged', saved]]);
    assert.equal((await readSettings(userData)).displayZone, 'America/Chicago');

    await assert.rejects(invoke('epoch:setDisplayZone', 'CST'), /"CST" is not a time zone Epoch can show times in/);
    await assert.rejects(invoke('epoch:setDisplayZone', 42), /A time zone is a name/);
    assert.equal((await readSettings(userData)).displayZone, 'America/Chicago');
  });

  it('remembers only a folder that exists, and stops offering one that has gone', async () => {
    const folder = path.join(userData, 'backups');
    fs.mkdirSync(folder);
    await invoke('epoch:rememberBackupsFolder', folder);
    assert.equal((await invoke<{ backupsFolder: string | null }>('epoch:getSettings')).backupsFolder, folder);

    await assert.rejects(invoke('epoch:rememberBackupsFolder', 'relative'), /is not a folder Epoch can look in/);
    await assert.rejects(invoke('epoch:rememberBackupsFolder', path.join(userData, 'none')), /not a folder/);

    fs.rmdirSync(folder);
    assert.equal((await invoke<{ backupsFolder: string | null }>('epoch:getSettings')).backupsFolder, null);
  });

  it('offers UTC first and only zones it accepts', async () => {
    const zones = await invoke<string[]>('epoch:getDisplayZones');
    assert.equal(zones[0], 'UTC');
    assert.ok(zones.includes('America/Chicago'));
    assert.ok(!zones.some((zone) => zone.startsWith('Etc/')));
  });
});
