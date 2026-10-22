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
// Whether the main process stops the pull when asked; it refuses before a backup process runs.
let cancelStops = true;
const toasts: string[] = [];

vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ show: (message: string) => toasts.push(message) }) }));
vi.mock('../api/devices', () => ({
  devicesApi: {
    listDeviceBackupSources: async () => [{ id: 'ios', label: 'iPhone' }],
    checkDeviceBackupToolAvailable: async () => ({ available: true }),
    listConnectedDevices: async () => [IPHONE],
    getDevicePullState: async () => null,
    getToolSetupStatus: async () => null,
    selectDeviceBackupDestination: async () => '/pulls',
    getBackupEncryption: async () => true,
    listIncompleteBackups: async () => (pullRunning ? [] : [LEFT]),
    pullDeviceBackup: () =>
      new Promise((_resolve, reject) => {
        rejectPull = reject;
      }),
    cancelDeviceBackup: async () => cancelStops,
    onDeviceBackupProgress: (cb: (p: BackupProgress) => void) => ((progress = cb), () => undefined),
    onDeviceBackupStats: () => () => undefined,
    onToolAcquisitionOutput: () => () => undefined,
    onToolAcquisitionStepStarted: () => () => undefined,
    onToolAcquisitionFinished: () => () => undefined,
    onToolSetupEvent: () => () => undefined,
  },
}));

import { useDevicePull } from './useDevicePull';

afterEach(() => {
  pullRunning = false;
  rejectPull = null;
  cancelStops = true;
  toasts.length = 0;
});

/** The hook with a device and a destination chosen, and a pull started. */
async function startedPull() {
  const view = renderHook(() => useDevicePull());
  await waitFor(() => expect(view.result.current.phase).toBe('available'));
  act(() => view.result.current.setSelectedDevice(IPHONE));
  await act(async () => {
    await view.result.current.handleSelectDestination();
  });
  let pulling: Promise<unknown> = Promise.resolve();
  await act(async () => {
    pulling = view.result.current.handlePull('password');
  });
  await waitFor(() => expect(rejectPull).not.toBeNull());
  return { ...view, pulling: () => pulling };
}

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

  it('reports a failure as a failure after a cancel that was refused (CodeRabbit, PR #135)', async () => {
    const { result, pulling } = await startedPull();
    cancelStops = false;
    await act(async () => result.current.cancelPull());
    expect(result.current.cancelling).toBe(false);
    expect(toasts[0]).toMatch(/can't be cancelled until the backup starts/);

    await act(async () => progress?.({ phase: 'error', message: 'The iPhone disconnected.' }));
    await act(async () => {
      rejectPull?.(new Error('The iPhone disconnected.'));
      await pulling().catch(() => undefined);
    });
    expect(result.current.pullError).toBe('The iPhone disconnected.');
    expect(result.current.pullCancelled).toBe(false);
  });

  it('reports a cancel that stopped the pull as cancelled', async () => {
    const { result, pulling } = await startedPull();
    await act(async () => result.current.cancelPull());
    await act(async () => progress?.({ phase: 'error', message: 'The backup of iPhone was cancelled.' }));
    await act(async () => {
      rejectPull?.(new Error('The backup of iPhone was cancelled.'));
      await pulling().catch(() => undefined);
    });
    expect(result.current.pullCancelled).toBe(true);
  });
});
