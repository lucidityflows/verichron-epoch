/**
 * A page follows each task's log (EPOCH-487, EPOCH-570). Entries are numbered
 * within their task, so a second task in the same session, numbered from 1
 * again, must show in full rather than be taken for entries already shown.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { TaskLogEntry } from '@verichron/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { AnalysisState } from '../../shared/types/window';

let logListener: ((entry: TaskLogEntry) => void) | null = null;
let stateListener: ((state: AnalysisState) => void) | null = null;
const idle: AnalysisState = {
  status: 'idle',
  kind: null,
  target: null,
  startedAt: null,
  currentStage: null,
  result: null,
  taskLog: null,
  workspace: null,
  log: [],
};

vi.mock('../api/pipeline', () => ({
  pipelineApi: {
    getAnalysisState: async () => idle,
    onAnalysisState: (cb: (state: AnalysisState) => void) => ((stateListener = cb), () => undefined),
    onOrchestratorLog: (cb: (entry: TaskLogEntry) => void) => ((logListener = cb), () => undefined),
    getPrepareState: async () => idle,
    onPrepareState: () => () => undefined,
    onPrepareLog: () => () => undefined,
  },
}));

import { useAnalysisState } from './usePipelineState';

const entry = (task: string, seq: number, message: string): TaskLogEntry => ({
  v: 1,
  task_id: task,
  seq,
  at: '2026-10-18T15:21:03.000Z',
  clock: 'received',
  level: 'info',
  source: 'app',
  label: null,
  step: null,
  kind: 'message',
  message,
});

const FIRST = '1f3a9c2e-0000-4000-8000-000000000001';
const SECOND = '1f3a9c2e-0000-4000-8000-000000000002';

describe('useAnalysisState', () => {
  it("shows a second task's log in full, though its entries are numbered from 1 again", async () => {
    const { result } = renderHook(() => useAnalysisState());
    await waitFor(() => expect(result.current.state).not.toBeNull());

    await act(async () => {
      [1, 2, 3].forEach((n) => logListener!(entry(FIRST, n, `first ${n}`)));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(result.current.log.map((e) => e.message)).toEqual(['first 1', 'first 2', 'first 3']);

    await act(async () => {
      stateListener!({ ...idle, status: 'running', startedAt: 2000 });
      [1, 2].forEach((n) => logListener!(entry(SECOND, n, `second ${n}`)));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(result.current.log.map((e) => e.message)).toEqual(['second 1', 'second 2']);
  });
});
