export const settingsApi = {
  getSettings: () => window.epoch.getSettings(),
  getDisplayZones: () => window.epoch.getDisplayZones(),
  setDisplayZone: (zone: string) => window.epoch.setDisplayZone(zone),
  rememberBackupsFolder: (folder: string) => window.epoch.rememberBackupsFolder(folder),
  onSettingsChanged: (callback: Parameters<typeof window.epoch.onSettingsChanged>[0]) =>
    window.epoch.onSettingsChanged(callback),
};
