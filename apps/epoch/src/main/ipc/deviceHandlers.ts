import { app, ipcMain, dialog, BrowserWindow } from 'electron';
import {
  addPullDestination,
  pullFolderName,
  readPullDestinations,
  removePullDestination,
} from '../tools/device-backup/pullDestinations';
import { PullStateTracker } from '../tools/device-backup/pullState';
import { logPullProgress } from '../tools/device-backup/pullLog';
import { PullLogSession } from './pipelineSessions';
import { defaultWorkspace } from './preparedBackups';
import { TaskLog } from './taskLog';
import { popOutWindows } from '../windows';
import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import {
  listDeviceBackupSources,
  getDeviceBackupSource,
  getAcquisitionStrategy,
} from '../tools/device-backup/registry';
import type {
  DeviceInfo,
  ToolAcquisitionCommand,
  BackupProgress,
  BackupStats,
  DevicePullState,
  IncompleteBackup,
  PullOptions,
  ToolAcquisitionResult,
  ToolSetupEvent,
  ToolSetupResult,
  ToolSetupStatus,
} from '../../shared/types/tools';

export function registerDeviceHandlers(
  getMainWindow: () => BrowserWindow | null,
  repoRoot: string,
  appVersion: string
) {
  // The running pull, so a panel that mounts mid-pull can show it (EPOCH-467).
  const pull = new PullStateTracker();
  // Its task log, for the Activity Log (EPOCH-436).
  const pullLog = new PullLogSession((state) => sendToRenderer('epoch:pullLogState', state));
  // Whether the examiner asked the running pull to stop: its log then ends cancelled, not failed.
  let cancelRequested = false;

  // To the main window and every pop-out, as Prepare and Analyze do, so a
  // popped-out Activity Log follows a pull too (EPOCH-436).
  function sendToRenderer(channel: string, ...args: unknown[]) {
    const win = getMainWindow();
    for (const target of [...(win ? [win] : []), ...popOutWindows()]) target.webContents.send(channel, ...args);
  }

  ipcMain.handle('epoch:selectDeviceBackupDestination', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose where to save the new backup',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('epoch:listDeviceBackupSources', async () => {
    return listDeviceBackupSources().map((source) => ({ id: source.id, label: source.label }));
  });

  ipcMain.handle('epoch:checkDeviceBackupToolAvailable', async (_event, sourceId: string) => {
    const source = getDeviceBackupSource(sourceId);
    if (!source) throw new Error(`Unknown device backup source: ${sourceId}`);
    return source.checkToolAvailable();
  });

  ipcMain.handle('epoch:listConnectedDevices', async (_event, sourceId: string) => {
    const source = getDeviceBackupSource(sourceId);
    if (!source) throw new Error(`Unknown device backup source: ${sourceId}`);
    // No device queries during a pull (EPOCH-467): the device being backed up is the one listed.
    const running = pull.current();
    if (running) return [running.device];
    return source.listConnectedDevices();
  });

  ipcMain.handle('epoch:getToolAcquisitionActions', async (_event, sourceId: string) => {
    const strategy = getAcquisitionStrategy(sourceId);
    if (!strategy) throw new Error(`Unknown device backup source: ${sourceId}`);
    return strategy.availableActions();
  });

  ipcMain.handle('epoch:getDevicePullState', async (): Promise<DevicePullState | null> => pull.current());
  ipcMain.handle('epoch:getPullLogState', async () => pullLog.snapshot());

  ipcMain.handle('epoch:getBackupEncryption', async (_event, sourceId: string, device: DeviceInfo) => {
    // A device query during a backup would compete with it for the device.
    if (pull.running()) throw new Error('A device backup is running. Wait for it to finish or cancel it first.');
    const source = getDeviceBackupSource(sourceId);
    if (!source) throw new Error(`Unknown device backup source: ${sourceId}`);
    return source.backupEncryptionEnabled(device);
  });

  ipcMain.handle('epoch:cancelDeviceBackup', async (_event, sourceId: string) => {
    const source = getDeviceBackupSource(sourceId);
    if (!source) throw new Error(`Unknown device backup source: ${sourceId}`);
    // Only a stop that happened makes the pull's outcome "cancelled"; a refused
    // one (no backup process yet) leaves a later failure a failure (§8.5).
    const stopping = source.cancelPull();
    if (pull.running() && stopping) cancelRequested = true;
    return stopping;
  });

  // Incomplete backups in every folder pulls have written to, plus the
  // chosen one, so leftovers are found after the user picks another folder.
  ipcMain.handle(
    'epoch:listIncompleteBackups',
    async (_event, sourceId: string, device: DeviceInfo, destDir: string | null): Promise<IncompleteBackup[]> => {
      const source = getDeviceBackupSource(sourceId);
      if (!source) throw new Error(`Unknown device backup source: ${sourceId}`);
      const known = await readPullDestinations(app.getPath('userData'));
      const folders = [...new Set([...(destDir ? [destDir] : []), ...known])];
      const found: IncompleteBackup[] = [];
      for (const folder of folders) {
        // The backup being written isn't finished yet, but it isn't left over either.
        if (pull.writes(folder, device.id)) continue;
        const incomplete = await source.incompleteBackup(folder, device);
        if (incomplete) found.push(incomplete);
      }
      return found;
    }
  );

  ipcMain.handle(
    'epoch:deleteIncompleteBackup',
    async (_event, sourceId: string, destDir: string, device: DeviceInfo) => {
      if (pull.running()) throw new Error('A device backup is running; cancel it before deleting.');
      const source = getDeviceBackupSource(sourceId);
      if (!source) throw new Error(`Unknown device backup source: ${sourceId}`);
      // Only a folder an earlier pull wrote to, so the renderer can't name an arbitrary one.
      const known = await readPullDestinations(app.getPath('userData'));
      if (!known.includes(destDir)) throw new Error(`${destDir} isn't a folder Epoch has pulled a backup to.`);
      return source.deleteIncompleteBackup(destDir, device);
    }
  );

  // EPOCH-519: crash logs copied again for a finished backup after a failed copy.
  ipcMain.handle(
    'epoch:copyDeviceCrashReports',
    async (_event, sourceId: string, device: DeviceInfo, backupDir: string) => {
      if (pull.running()) throw new Error('A device backup is running; wait for it to finish.');
      const source = getDeviceBackupSource(sourceId);
      if (!source) throw new Error(`Unknown device backup source: ${sourceId}`);
      return source.copyCrashReportsAgain(device, backupDir);
    }
  );

  ipcMain.handle(
    'epoch:copyDeviceCrashReportsByReference',
    async (_event, sourceId: string, deviceRef: string, backupDir: string) => {
      if (pull.running()) throw new Error('A device backup is running; wait for it to finish.');
      const source = getDeviceBackupSource(sourceId);
      if (!source) throw new Error(`Unknown device backup source: ${sourceId}`);
      return source.copyCrashReportsAgainByReference(deviceRef, backupDir);
    }
  );

  ipcMain.handle('epoch:findCrashReportsRetryTargets', async (_event, sourceId: string, backupDirs: unknown) => {
    if (!Array.isArray(backupDirs) || !backupDirs.every((backupDir) => typeof backupDir === 'string')) {
      throw new Error('Backup paths must be a list of strings.');
    }
    if (pull.running()) return { targets: [], errors: [] };
    const source = getDeviceBackupSource(sourceId);
    if (!source) throw new Error(`Unknown device backup source: ${sourceId}`);
    return source.findCrashReportsRetryTargets(backupDirs);
  });

  ipcMain.handle(
    'epoch:pullDeviceBackup',
    async (_event, sourceId: string, device: DeviceInfo, destDir: string, options: PullOptions) => {
      if (!options?.password || options.password.trim() === '') {
        throw new Error('A backup password is required.');
      }
      const source = getDeviceBackupSource(sourceId);
      if (!source) throw new Error(`Unknown device backup source: ${sourceId}`);

      // Each pull writes into a folder of its own inside the one chosen
      // (EPOCH-504), created here and never reused: a pull never meets an
      // existing backup. Created without `recursive`, so it fails rather than
      // share a folder with another pull.
      const pullDir = path.join(destDir, pullFolderName(new Date()));
      // Reserved before anything awaits, so a second pull is refused before it
      // creates or registers a folder.
      pull.start(sourceId, device, pullDir);
      let created = false;
      try {
        try {
          await fs.mkdir(pullDir);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(
              `Another pull into ${destDir} started this same second (${pullDir}). Wait a moment and try again.`,
              { cause: err }
            );
          }
          throw err;
        }
        created = true;
        await addPullDestination(app.getPath('userData'), pullDir);
      } catch (err) {
        // Nothing has been written into it yet: it leaves no trace (R14).
        if (created) await fs.rmdir(pullDir).catch(() => undefined);
        pull.end();
        throw err;
      }

      // The pull's task log (EPOCH-436), in the default workspace, never in
      // the pull's folder, which is evidence (owner, 2026-10-18). The backup's
      // folder is named by the device's UDID, so the sanitizer knows it from
      // the start (docs/event-log.md §6.3).
      const label = path.basename(pullDir);
      const workspace = defaultWorkspace();
      cancelRequested = false;
      pullLog.start(workspace);
      let log: TaskLog;
      try {
        log = await TaskLog.open(
          {
            workspace,
            kind: 'pull',
            labels: [label],
            options: { turn_on_encryption: Boolean(options.enableEncryption) },
            backups: [{ label, path: path.join(pullDir, device.id), beingWritten: true }],
            source: destDir,
            appRoot: repoRoot,
            appVersion,
            message: `iPhone pull started${device.model ? ` for ${device.model}` : ''}${
              device.osVersion ? `, iOS ${device.osVersion}` : ''
            }`,
          },
          (entry) => {
            pullLog.entry(entry);
            sendToRenderer('epoch:pullLog', entry);
          }
        );
      } catch (err) {
        // No log, no task (docs/event-log.md §7): the empty folder and its
        // registration leave no trace, and the Activity Log shows no pull.
        await fs.rmdir(pullDir).catch(() => undefined);
        await removePullDestination(app.getPath('userData'), pullDir).catch(() => undefined);
        pull.end();
        pullLog.reset();
        throw new Error(
          `The task log could not be created, so the pull did not start: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
      pullLog.logFile(log.file);
      log.addSecret(options.password);

      let failure: string | null = null;
      try {
        return await source.pullBackup(
          device,
          pullDir,
          (progress: BackupProgress) => {
            pull.progress(progress);
            logPullProgress(log, label, progress);
            if (progress.phase === 'error') failure = progress.message;
            sendToRenderer('epoch:deviceBackupProgress', progress);
          },
          (stats: BackupStats) => {
            pull.stats(stats);
            sendToRenderer('epoch:deviceBackupStats', stats);
          },
          options
        );
      } catch (err) {
        failure ??= err instanceof Error ? err.message : String(err);
        // Every pull ends with done or an error on the progress channel, so a
        // panel that mounted mid-pull (and isn't awaiting this call) sees it end.
        if (!pull.reportedEnd()) {
          sendToRenderer('epoch:deviceBackupProgress', {
            phase: 'error',
            message: failure,
          } satisfies BackupProgress);
        }
        throw err;
      } finally {
        // The pull stays reserved until its log is closed, so another pull
        // can't start and have its session ended by this one's finish.
        try {
          const outcome = failure === null ? 'succeeded' : cancelRequested ? 'cancelled' : 'failed';
          // The result reaches the Activity Log through the log's own delivery, like every entry.
          await log.finish(
            { outcome, exitCode: null, signal: null, reported: true, failedLabels: failure === null ? [] : [label] },
            failure === null
              ? 'iPhone pull finished'
              : cancelRequested
                ? 'iPhone pull cancelled'
                : `iPhone pull failed: ${failure}`
          );
          pullLog.finish();
        } finally {
          pull.end();
        }
      }
    }
  );

  let acquisitionInFlight = false;

  ipcMain.handle(
    'epoch:runToolAcquisitionSteps',
    async (_event, steps: ToolAcquisitionCommand[], installPrefix: string): Promise<ToolAcquisitionResult> => {
      if (acquisitionInFlight) {
        throw new Error('A tool acquisition run is already in progress.');
      }
      acquisitionInFlight = true;

      try {
        if (steps.length > 0) {
          const buildRoot = steps[0].cwd;
          if (buildRoot) await fs.mkdir(buildRoot, { recursive: true }).catch(() => undefined);
        }
        await fs.mkdir(installPrefix, { recursive: true }).catch(() => undefined);

        for (const step of steps) {
          sendToRenderer('epoch:toolAcquisitionStepStarted', step.label);
          const pkgConfigPath = path.join(installPrefix, 'lib', 'pkgconfig');

          const env: NodeJS.ProcessEnv = {
            ...process.env,
            PKG_CONFIG_PATH: [pkgConfigPath, process.env.PKG_CONFIG_PATH].filter(Boolean).join(path.delimiter),
          };

          const exitCode = await new Promise<number>((resolve, reject) => {
            const child = spawn(step.command, step.args, { cwd: step.cwd, env });
            child.stdout?.on('data', (chunk: Buffer) => {
              sendToRenderer('epoch:toolAcquisitionOutput', { step: step.label, line: chunk.toString('utf-8') });
            });
            child.stderr?.on('data', (chunk: Buffer) => {
              sendToRenderer('epoch:toolAcquisitionOutput', { step: step.label, line: chunk.toString('utf-8') });
            });
            child.once('error', reject);
            child.once('close', (code) => resolve(code ?? 1));
          });

          if (exitCode !== 0) {
            const result: ToolAcquisitionResult = { success: false, failedStep: step.label };
            sendToRenderer('epoch:toolAcquisitionFinished', result);
            return result;
          }
        }

        const result: ToolAcquisitionResult = { success: true };
        sendToRenderer('epoch:toolAcquisitionFinished', result);
        return result;
      } finally {
        acquisitionInFlight = false;
      }
    }
  );

  // Guided setup (EPOCH-465): Linux and macOS. One run at a time, shared with
  // the Windows acquisition steps above.
  function guidedFor(sourceId: string) {
    const guided = getAcquisitionStrategy(sourceId)?.guided;
    if (!guided) throw new Error(`Guided setup isn't available for ${sourceId} on this platform`);
    return guided;
  }

  async function runGuided(work: (emit: (event: ToolSetupEvent) => void) => Promise<ToolSetupResult>) {
    if (acquisitionInFlight) throw new Error('A setup run is already in progress.');
    acquisitionInFlight = true;
    try {
      return await work((event) => sendToRenderer('epoch:toolSetupEvent', event));
    } finally {
      acquisitionInFlight = false;
    }
  }

  ipcMain.handle('epoch:getToolSetupStatus', async (_event, sourceId: string): Promise<ToolSetupStatus | null> => {
    const guided = getAcquisitionStrategy(sourceId)?.guided;
    return guided ? guided.status() : null;
  });

  ipcMain.handle('epoch:installToolSetupRequirements', async (_event, sourceId: string): Promise<ToolSetupResult> =>
    runGuided((emit) => guidedFor(sourceId).installRequirements(emit))
  );

  ipcMain.handle('epoch:buildToolSetup', async (_event, sourceId: string): Promise<ToolSetupResult> =>
    runGuided((emit) => guidedFor(sourceId).build(emit))
  );
}
