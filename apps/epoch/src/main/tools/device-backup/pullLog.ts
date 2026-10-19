import type { TaskLog } from '../../ipc/taskLog';
import type { BackupProgress } from '../../../shared/types/tools';

/**
 * How one of the pull's messages is kept in its task log (EPOCH-436).
 *
 * - A line idevicebackup2 printed is debug, by its source, like any tool output.
 * - Epoch's own messages (what it is doing, what to do on the iPhone) are info.
 * - The pull's failure is not kept here: it is the log's last entry, the
 *   result, so one failure counts as one error (docs/event-log.md §5).
 */
export function logPullProgress(
  log: Pick<TaskLog, 'app' | 'toolOutput'>,
  label: string,
  progress: BackupProgress
): void {
  if (progress.phase === 'error') return;
  if (progress.tool) log.toolOutput('idevicebackup2', progress.message, { label });
  else log.app('info', progress.message, { label });
}
