import assert from 'node:assert/strict';
import { it, vi } from 'vitest';
import type { EpochBridge } from '../shared/ipc/channels';

const { exposeInMainWorld, invoke, on, removeListener } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async (channel: string, ...args: unknown[]) => ({ channel, args })),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
}));

import './preload';

it('exposes typed invoke and payload-only event subscriptions with cleanup', async () => {
  const bridge = exposeInMainWorld.mock.calls[0][1] as EpochBridge;
  const returned = await bridge.invoke('epoch:displayPath', '/backups');
  assert.deepEqual(returned, { channel: 'epoch:displayPath', args: ['/backups'] });
  assert.equal(invoke.mock.calls[0][0], 'epoch:displayPath');

  const settingsPayload = { displayZone: 'UTC', backupsFolder: null };
  const receive = vi.fn();
  const unsubscribe = bridge.on('epoch:settingsChanged', receive);
  const listener = on.mock.calls[0][1] as (event: unknown, payload: typeof settingsPayload) => void;
  listener({ type: 'ipc-event' }, settingsPayload);

  assert.deepEqual(receive.mock.calls, [[settingsPayload]]);
  unsubscribe();
  assert.equal(removeListener.mock.calls[0][0], 'epoch:settingsChanged');
  assert.equal(removeListener.mock.calls[0][1], listener);
});
