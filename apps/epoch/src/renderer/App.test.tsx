/**
 * EPOCH-575: during an iPhone pull, leaving New Investigation and returning
 * shows the Activity Log again, following the pull, with its drawer as the
 * examiner left it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeviceInfo, DevicePullState } from '../shared/types/tools';

const IPHONE: DeviceInfo = {
  id: '00008140-0000000000000000',
  name: 'iPhone',
  model: 'iPhone17,5',
  osVersion: '26.6.1',
};
const started = Date.now() - 120_000;

const running: DevicePullState = {
  sourceId: 'ios',
  device: IPHONE,
  destDir: '/pulls/2026-10-19T172427Z',
  startedAt: started,
  progress: [{ phase: 'transferring', step: 'copy', message: 'Receiving files', tool: true }],
  stats: { startedAt: started, receivedBytes: 4e9, lastDataAt: Date.now(), percent: 5, estimatedBytes: 75e9 },
  steps: {
    startedAt: { check: started, approve: started + 1_000, copy: started + 20_000 },
    endedAt: null,
    failed: false,
  },
  deviceAction: null,
  ended: false,
};

const pullLog = {
  status: 'running',
  startedAt: started,
  taskLog: 'pull-2026-10-19T172427Z-d935850e.ndjson',
  workspace: '/workspace',
  log: [
    {
      v: 1,
      task_id: 'd935850e-0000-4000-8000-000000000000',
      seq: 1,
      at: new Date(started).toISOString(),
      clock: 'received',
      level: 'info',
      source: 'app',
      kind: 'message',
      label: null,
      step: 'check',
      message: 'Checking the backup settings of iPhone…',
    },
  ],
};
const idle = { status: 'idle', startedAt: null, taskLog: null, workspace: null, log: [] };

const answers: Record<string, unknown> = {
  getDevicePullState: running,
  getPullLogState: pullLog,
  getPrepareState: { ...idle, source: null, labels: [], progress: null, passwordFor: null, result: null },
  getAnalysisState: { ...idle, kind: null, target: null, currentStage: null, result: null },
  listDeviceBackupSources: [{ id: 'ios', label: 'iPhone' }],
  checkDeviceBackupToolAvailable: { available: true },
  listConnectedDevices: [IPHONE],
  getToolSetupStatus: null,
  getPipelineRuns: [],
  getPreparedBackups: { workspace: '/workspace', backups: [] },
  listTaskLogs: [],
  displayPath: '~/pulls',
};

// Every IPC call answers as the main process does mid-pull; a subscription returns its unsubscribe.
vi.stubGlobal(
  'epoch',
  new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name === 'platform') return 'linux';
        if (name.startsWith('on')) return () => () => undefined;
        return async () => (name in answers ? answers[name] : []);
      },
    }
  )
);

// jsdom has no matchMedia; Electron does. A tall window.
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
}));

import { App } from './App';
import { ToastProvider } from './components/ui/Toast';

afterEach(cleanup);

describe('App (EPOCH-575)', () => {
  it('shows the Activity Log again after leaving New Investigation and returning during a pull', async () => {
    render(
      <ToastProvider>
        <App />
      </ToastProvider>
    );
    // The app opens on Investigations.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /New Investigation/ })));
    await screen.findByRole('heading', { name: /Pulling iPhone17,5/ });
    expect(screen.getByRole('region', { name: 'Activity Log' })).toBeTruthy();
    // The examiner opens the drawer and picks the Full log.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Activity Log/ })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Full log' })));

    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Investigations/ })));
    expect(screen.queryByRole('region', { name: 'Activity Log' })).toBeNull();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: /New Investigation/ })));
    await screen.findByRole('heading', { name: /Pulling iPhone17,5/ });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Activity Log' })).toBeTruthy());
    expect(screen.getByRole('region', { name: 'Activity Log' }).textContent).toContain('Checking the backup settings');
    // The drawer comes back as it was left: open, on the Full log.
    expect(screen.getByRole('button', { name: /^Activity Log/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Full log' }).getAttribute('aria-pressed')).toBe('true');
  });
});
