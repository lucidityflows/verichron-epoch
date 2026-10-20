import { create } from 'zustand';
import type { AppSettings } from '../../shared/types/window';
import type { DisplayZone } from '../../shared/time';

/**
 * The examiner's settings in this window (EPOCH-560). The main process keeps
 * them; `SettingsGate` loads them before any view renders and follows every
 * change, so each window shows times in the same zone.
 */
interface SettingsState {
  settings: AppSettings | null;
  setSettings: (settings: AppSettings) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  setSettings: (settings) => set({ settings }),
}));

/** The settings, which `SettingsGate` has loaded before anything that reads them renders. */
export function useSettings(): AppSettings {
  const settings = useSettingsStore((state) => state.settings);
  if (!settings) throw new Error('the settings were read before they were loaded');
  return settings;
}

/** The zone every time is shown in: UTC by default, or the zone chosen in Settings. */
export function useDisplayZone(): DisplayZone {
  return useSettings().displayZone;
}
