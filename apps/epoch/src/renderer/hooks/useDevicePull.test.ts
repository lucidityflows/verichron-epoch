/**
 * A cancelled or failed pull's incomplete backup is offered for deletion
 * (EPOCH-483, EPOCH-554). The pull's error arrives as progress while the main
 * process still counts the pull as running, so a lookup made then skips its
 * folder; the panel looks again once the pull call has returned.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BackupProgress, DeviceInfo, IncompleteBackup } from '../../shared/types/tools';

const IPHONE: DeviceInfo = {
  id: '00008140-0000000000000000',
  name: 'iPhone',
  model: 'iPhone17,5',
  osVersion: '26.6.1',
};
const LEFT: IncompleteBackup = {
  destDir: '/pulls/2026-10-19T165305Z',
  path: '/pulls/2026-10-19T165305Z/x',
  bytes: 4e9,
};

let progress: ((p: BackupProgress) => void) | null = null;
// Whether the main process still counts the pull as running, as pull.writes() does.
let pullRunning = false;
let rejectPull: ((err: Error) => void) | null = null;

vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ show: () => undefined }) }));
vi.mock('../api/devices', () => ({
  devicesApi: {
    getDevicePullState: async () => null,
    getToolSetupStatus: async () => null,
    selectDeviceBackupDestination: async () => '/pulls',
    getBackupEncryption: async () => true,
    listIncompleteBackups: async () => (pullRunning ? [] : [LEFT]),
    pullDeviceBackup: () =>
      new Promise((_resolve, reject) => {
        rejectPull = reject;
      }),
    onDeviceBackupProgress: (cb: (p: BackupProgress) => void) => ((progress = cb), () => undefined),
    onDeviceBackupStats: () => () => undefined,
    onToolAcquisitionOutput: () => () => undefined,
    onToolAcquisitionFinished: () => () => undefined,
    onToolSetupEvent: () => () => undefined,
  },
}));

vi.stubGlobal('epoch', {
  listDeviceBackupSources: async () => [{ id: 'ios', label: 'iPhone' }],
  checkDeviceBackupToolAvailable: async () => ({ available: true }),
  listConnectedDevices: async () => [IPHONE],
  onToolAcquisitionStepStarted: () => () => undefined,
});

import { useDevicePull } from './useDevicePull';

afterEach(() => {
  pullRunning = false;
  rejectPull = null;
});

describe('useDevicePull', () => {
  it('offers the incomplete backup a cancelled pull left, once the pull has ended', async () => {
    const { result } = renderHook(() => useDevicePull());
    await waitFor(() => expect(result.current.phase).toBe('available'));
    act(() => result.current.setSelectedDevice(IPHONE));
    await act(async () => {
      await result.current.handleSelectDestination();
    });

    pullRunning = true;
    let pulling: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pulling = result.current.handlePull('password');
    });
    await waitFor(() => expect(rejectPull).not.toBeNull());

    // The error arrives while the main process still counts the pull as running.
    await act(async () => progress?.({ phase: 'error', message: 'The backup of iPhone was cancelled.' }));
    expect(result.current.incomplete).toEqual([]);

    // The pull ends, and then its call returns.
    pullRunning = false;
    await act(async () => {
      rejectPull?.(new Error('The backup of iPhone was cancelled.'));
      await pulling;
    });
    await waitFor(() => expect(result.current.incomplete).toEqual([LEFT]));
  });
});
