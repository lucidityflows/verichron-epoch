import { app, ipcMain, dialog, BrowserWindow } from 'electron';
import { addPullDestination, readPullDestinations } from '../tools/device-backup/pullDestinations';
import { PullStateTracker } from '../tools/device-backup/pullState';
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

export function registerDeviceHandlers(getMainWindow: () => BrowserWindow | null) {
  // The running pull, so a panel that mounts mid-pull can show it (EPOCH-467).
  const pull = new PullStateTracker();

  function sendToRenderer(channel: string, ...args: unknown[]) {
    const win = getMainWindow();
    if (win) {
      win.webContents.send(channel, ...args);
    }
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
    return source.cancelPull();
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

  ipcMain.handle(
    'epoch:pullDeviceBackup',
    async (_event, sourceId: string, device: DeviceInfo, destDir: string, options: PullOptions) => {
      if (!options?.password || options.password.trim() === '') {
        throw new Error('A backup password is required.');
      }
      const source = getDeviceBackupSource(sourceId);
      if (!source) throw new Error(`Unknown device backup source: ${sourceId}`);

      pull.start(sourceId, device, destDir);
      try {
        await addPullDestination(app.getPath('userData'), destDir);
        return await source.pullBackup(
          device,
          destDir,
          (progress: BackupProgress) => {
            pull.progress(progress);
            sendToRenderer('epoch:deviceBackupProgress', progress);
          },
          (stats: BackupStats) => {
            pull.stats(stats);
            sendToRenderer('epoch:deviceBackupStats', stats);
          },
          options
        );
      } catch (err) {
        // Every pull ends with done or an error on the progress channel, so a
        // panel that mounted mid-pull (and isn't awaiting this call) sees it end.
        if (!pull.reportedEnd()) {
          sendToRenderer('epoch:deviceBackupProgress', {
            phase: 'error',
            message: err instanceof Error ? err.message : String(err),
          } satisfies BackupProgress);
        }
        throw err;
      } finally {
        pull.end();
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
