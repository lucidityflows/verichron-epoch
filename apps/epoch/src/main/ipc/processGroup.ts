import type { ChildProcess } from 'child_process';

/**
 * Signals a task's whole process group (EPOCH-570): the app starts the
 * processor and the orchestrator through pnpm, which exits on a signal without
 * passing it on, leaving tsx and the program running, orphaned, with the
 * output pipe still open. Each task is started in a group of its own
 * (`detached`), so a stop reaches all of it. A child with no pid (a test
 * double) is signalled directly.
 */
export function signalTask(child: Pick<ChildProcess, 'pid' | 'kill'>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    // ESRCH: the group has already ended.
    if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH')) throw err;
  }
}
