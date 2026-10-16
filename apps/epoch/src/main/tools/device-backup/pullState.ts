import type { BackupProgress, BackupStats, DevicePullState, DeviceInfo } from '../../../shared/types/tools';

/**
 * The device pull that is running, kept in the main process (EPOCH-467).
 *
 * The renderer's panel unmounts when the user leaves New Investigation, and
 * its state goes with it. On return it reads this to show the running pull
 * again (progress, the device-action banner, Cancel) and keep Pull locked,
 * instead of offering a second pull while the first is still running.
 */

/** Progress lines kept for a panel that mounts mid-pull; the newest are kept. */
export const PULL_STATE_PROGRESS_LIMIT = 500;

/**
 * The device-action banner after `progress`: set by a device-action, kept
 * through setup lines, cleared once files arrive or the pull ends. The panel
 * applies the same rule to live progress (useDevicePull.ts).
 */
export function nextDeviceAction(prev: string | null, progress: BackupProgress): string | null {
  if (progress.phase === 'device-action') return progress.message;
  return progress.phase === 'preparing' ? prev : null;
}

export class PullStateTracker {
  private state: DevicePullState | null = null;

  /** Starts tracking a pull; refuses while another is tracked. */
  start(sourceId: string, device: DeviceInfo, destDir: string, now = Date.now()): void {
    if (this.state)
      throw new Error('A device backup is already in progress -- wait for it to finish before starting another.');
    this.state = {
      sourceId,
      device,
      destDir,
      startedAt: now,
      progress: [],
      stats: null,
      deviceAction: null,
      ended: false,
    };
  }

  progress(progress: BackupProgress): void {
    if (!this.state) return;
    const kept = [...this.state.progress, progress];
    this.state.progress = kept.length > PULL_STATE_PROGRESS_LIMIT ? kept.slice(-PULL_STATE_PROGRESS_LIMIT) : kept;
    this.state.deviceAction = nextDeviceAction(this.state.deviceAction, progress);
    if (progress.phase === 'done' || progress.phase === 'error') this.state.ended = true;
  }

  stats(stats: BackupStats): void {
    if (this.state) this.state.stats = stats;
  }

  /** Whether the pull already reported how it ended (done or error). */
  reportedEnd(): boolean {
    return this.state?.ended ?? false;
  }

  end(): void {
    this.state = null;
  }

  current(): DevicePullState | null {
    return this.state ? { ...this.state, progress: [...this.state.progress] } : null;
  }

  running(): boolean {
    return this.state !== null;
  }

  /** Whether `destDir` and `deviceId` name the backup this pull is writing. */
  writes(destDir: string, deviceId: string): boolean {
    return this.state !== null && this.state.destDir === destDir && this.state.device.id === deviceId;
  }
}
