import { invokeIpc } from './ipc';
import type { AppSettings } from '../../shared/types/window';

export const settingsApi = {
  getSettings: () => invokeIpc('epoch:getSettings'),
  getDisplayZones: () => invokeIpc('epoch:getDisplayZones'),
  setDisplayZone: (zone: string) => invokeIpc('epoch:setDisplayZone', zone),
  rememberBackupsFolder: (folder: string) => invokeIpc('epoch:rememberBackupsFolder', folder),
  onSettingsChanged: (callback: (settings: AppSettings) => void) => window.epoch.on('epoch:settingsChanged', callback),
};
