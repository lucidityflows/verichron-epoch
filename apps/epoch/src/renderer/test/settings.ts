/**
 * Renderer tests start from the default settings, as the app does once
 * SettingsGate has loaded them (EPOCH-560): times in UTC, no remembered
 * folder. A test of another zone sets it with `useSettingsStore.setState`.
 */
import { beforeEach } from 'vitest';

import { useSettingsStore } from '../store/useSettings';

beforeEach(() => useSettingsStore.setState({ settings: { displayZone: 'UTC', backupsFolder: null } }));
