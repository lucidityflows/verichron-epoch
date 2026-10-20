import fs from 'fs/promises';
import path from 'path';
import electron from 'electron';
import type { BrowserWindow } from 'electron';
import { displayZone, displayZones } from '@verichron/contracts';
import { readSettings, updateSettings } from '../settings';
import { popOutWindows } from '../windows';
import type { AppSettings } from '../../shared/types/window';

const { app, ipcMain } = electron;

/** The folder still exists as a folder; a remembered one that has gone is not offered. */
async function isFolder(folder: string): Promise<boolean> {
  return (await fs.stat(folder).catch(() => null))?.isDirectory() ?? false;
}

/**
 * The settings (EPOCH-560), for every window: a change made in one reaches
 * the others, so the Activity Log's pop-out shows times in the same zone.
 */
export function registerSettingsHandlers(getMainWindow: () => BrowserWindow | null): void {
  const settingsDir = () => app.getPath('userData');

  const shown = async (settings: AppSettings): Promise<AppSettings> => ({
    ...settings,
    backupsFolder: settings.backupsFolder && (await isFolder(settings.backupsFolder)) ? settings.backupsFolder : null,
  });

  const changed = async (settings: AppSettings) => {
    const value = await shown(settings);
    const main = getMainWindow();
    for (const target of [...(main ? [main] : []), ...popOutWindows()]) {
      target.webContents.send('epoch:settingsChanged', value);
    }
    return value;
  };

  ipcMain.handle('epoch:getSettings', async () => shown(await readSettings(settingsDir())));

  // Every zone the examiner can choose, from the same zone database the renderer formats with.
  ipcMain.handle('epoch:getDisplayZones', () => displayZones());

  ipcMain.handle('epoch:setDisplayZone', async (_event, zone: unknown) => {
    if (typeof zone !== 'string') throw new Error('A time zone is a name such as America/Chicago.');
    return changed(await updateSettings(settingsDir(), { displayZone: displayZone(zone) }));
  });

  ipcMain.handle('epoch:rememberBackupsFolder', async (_event, folder: unknown) => {
    if (typeof folder !== 'string' || !path.isAbsolute(folder) || !(await isFolder(folder))) {
      throw new Error(`${String(folder)} is not a folder Epoch can look in.`);
    }
    return changed(await updateSettings(settingsDir(), { backupsFolder: folder }));
  });
}
