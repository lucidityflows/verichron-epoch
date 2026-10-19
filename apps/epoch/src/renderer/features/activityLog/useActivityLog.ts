import { useEffect, useState } from 'react';
import type { TaskLogEntry } from '@verichron/contracts';

import { pipelineApi } from '../../api/pipeline';
import { useAnalysisState, usePrepareState, usePullLogState } from '../../hooks/usePipelineState';

export interface ActivityLogSource {
  entries: TaskLogEntry[];
  live: boolean;
  /** The saved log behind the entries, for Save As… */
  workspace: string | null;
  file: string | null;
  /** The log could not be read back; said, never hidden. */
  error: string | null;
}

/**
 * The task the Activity Log follows (EPOCH-570, EPOCH-436): the running pull,
 * Prepare or Analyze, else the one started last. After a restart neither has run in
 * this session, so the workspace's newest saved log is read back; one that
 * never finished reads as such (docs/event-log.md §4).
 */
export function useActivityLog(): ActivityLogSource {
  const { state: prepare, log: prepareLog } = usePrepareState();
  const { state: analysis, log: analysisLog } = useAnalysisState();
  const { state: pull, log: pullLog } = usePullLogState();
  const [saved, setSaved] = useState<{ workspace: string; file: string; entries: TaskLogEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ranThisSession = Boolean(prepare?.startedAt || analysis?.startedAt || pull?.startedAt);
  const loaded = prepare !== null && analysis !== null && pull !== null;

  useEffect(() => {
    if (!loaded || ranThisSession) return;
    let active = true;
    (async () => {
      const { workspace } = await pipelineApi.getPreparedBackups();
      const [newest] = await window.epoch.listTaskLogs(workspace);
      if (!newest) return;
      const read = await window.epoch.readTaskLog(workspace, newest.file);
      if (active) setSaved({ workspace, file: newest.file, entries: read.entries });
    })().catch((err: unknown) => {
      if (active) setError(`The last saved log could not be read: ${err instanceof Error ? err.message : String(err)}`);
    });
    return () => {
      active = false;
    };
  }, [loaded, ranThisSession]);

  if (!ranThisSession) {
    return {
      entries: saved?.entries ?? [],
      live: false,
      workspace: saved?.workspace ?? null,
      file: saved?.file ?? null,
      error,
    };
  }
  const followed = followedTask(prepare, analysis, pull);
  if (followed === 'pull') {
    return {
      entries: pullLog,
      live: pull?.status === 'running',
      workspace: pull?.workspace ?? null,
      file: pull?.taskLog ?? null,
      error,
    };
  }
  const analysisRunning = analysis?.status === 'running';
  const prepareRunning = prepare?.status === 'running';
  return followed === 'analysis'
    ? {
        entries: analysisLog,
        live: analysisRunning,
        workspace: analysis?.workspace ?? null,
        file: analysis?.taskLog ?? null,
        error,
      }
    : {
        entries: prepareLog,
        live: prepareRunning,
        workspace: prepare?.workspace ?? null,
        file: prepare?.taskLog ?? null,
        error,
      };
}

type TaskTiming = { status: string; startedAt: number | null } | null;

/**
 * Which task's log the drawer follows: a running one, else the one started
 * last. A pull runs on its own (it holds the device), so while it runs it is
 * the task.
 */
export function followedTask(
  prepare: TaskTiming,
  analysis: TaskTiming,
  pull: TaskTiming
): 'prepare' | 'analysis' | 'pull' {
  if (pull?.status === 'running') return 'pull';
  if (analysis?.status === 'running') return 'analysis';
  if (prepare?.status === 'running') return 'prepare';
  const started = (task: TaskTiming) => task?.startedAt ?? 0;
  const newest = Math.max(started(prepare), started(analysis), started(pull));
  if (started(pull) === newest && newest > 0) return 'pull';
  return started(analysis) > started(prepare) ? 'analysis' : 'prepare';
}
