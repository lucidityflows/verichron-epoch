import { useEffect, useState } from 'react';
import { pipelineApi } from '../api/pipeline';
import type { AnalysisState, PipelineLogEntry, PrepareState } from '../../shared/types/window';

/** The most log lines a page keeps; the main process keeps the same number. */
const MAX_LINES = 2000;

/** A state change without its log, which the change events never carry. */
function withoutLog<S extends { log: PipelineLogEntry[] }>(state: S): Omit<S, 'log'> {
  const copy: Partial<S> = { ...state };
  delete copy.log;
  return copy as Omit<S, 'log'>;
}

function trim(lines: PipelineLogEntry[]): PipelineLogEntry[] {
  return lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines;
}

/**
 * Follows a run whose state lives in the main process (EPOCH-487): it reads
 * the state and recent log when the page mounts, then applies each change.
 * Entries are numbered within their task (EPOCH-570), so one that arrives
 * while the state is being read is neither lost nor shown twice. A new task
 * (a new task id, or a new start time) starts a new log, and its numbering
 * starts again.
 */
function useRunState<S extends { startedAt: number | null; log: PipelineLogEntry[] }>(
  read: () => Promise<S>,
  onState: (callback: (state: S) => void) => () => void,
  onLog: (callback: (entry: PipelineLogEntry) => void) => () => void
): { state: Omit<S, 'log'> | null; log: PipelineLogEntry[] } {
  const [state, setState] = useState<Omit<S, 'log'> | null>(null);
  const [log, setLog] = useState<PipelineLogEntry[]>([]);

  useEffect(() => {
    let active = true;
    let loaded = false;
    let lastSeq = 0;
    let taskId: string | null = null;
    let startedAt: number | null = null;
    let early: PipelineLogEntry[] = [];
    let batch: PipelineLogEntry[] = [];
    let frame: number | null = null;

    const flush = () => {
      frame = null;
      if (batch.length === 0) return;
      const lines = batch;
      batch = [];
      setLog((prev) => trim([...prev, ...lines]));
    };

    const unsubLog = onLog((entry) => {
      if (!loaded) {
        early.push(entry);
        return;
      }
      if (entry.task_id !== taskId) {
        // Another task's entries: its numbering starts again at 1.
        taskId = entry.task_id;
        lastSeq = 0;
        batch = [];
        setLog([]);
      }
      if (entry.seq <= lastSeq) return;
      lastSeq = entry.seq;
      batch.push(entry);
      if (frame === null) frame = requestAnimationFrame(flush);
    });

    const unsubState = onState((next) => {
      if (loaded && next.startedAt !== startedAt) {
        startedAt = next.startedAt;
        taskId = null;
        lastSeq = 0;
        batch = [];
        setLog([]);
      }
      setState(withoutLog(next));
    });

    read().then((snapshot) => {
      if (!active) return;
      const recent = snapshot.log;
      const rest = withoutLog(snapshot);
      startedAt = rest.startedAt;
      taskId = recent.length > 0 ? recent[recent.length - 1].task_id : null;
      lastSeq = recent.length > 0 ? recent[recent.length - 1].seq : 0;
      // Early entries of another task than the snapshot's belong to a newer task.
      const newer = early.filter((entry) => entry.task_id !== taskId);
      const later =
        newer.length > 0
          ? newer.filter((entry) => entry.task_id === newer[newer.length - 1].task_id)
          : early.filter((entry) => entry.seq > lastSeq);
      if (newer.length > 0) {
        taskId = later[later.length - 1].task_id;
        lastSeq = 0;
      }
      if (later.length > 0) lastSeq = later[later.length - 1].seq;
      early = [];
      loaded = true;
      setState(rest);
      setLog(trim(newer.length > 0 ? later : [...recent, ...later]));
    });

    return () => {
      active = false;
      if (frame !== null) cancelAnimationFrame(frame);
      unsubLog();
      unsubState();
    };
  }, [read, onState, onLog]);

  return { state, log };
}

/** Prepare Evidence: progress, a password the processor is waiting for, and the result. */
export function usePrepareState() {
  return useRunState<PrepareState>(pipelineApi.getPrepareState, pipelineApi.onPrepareState, pipelineApi.onPrepareLog);
}

/** Analyze, for a workspace or for one backup retried from Investigations. */
export function useAnalysisState() {
  return useRunState<AnalysisState>(
    pipelineApi.getAnalysisState,
    pipelineApi.onAnalysisState,
    pipelineApi.onOrchestratorLog
  );
}
