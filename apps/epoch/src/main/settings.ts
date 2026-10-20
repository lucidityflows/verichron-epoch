import fs from 'fs/promises';
import path from 'path';
import { DEFAULT_DISPLAY_ZONE, isDisplayZone } from '@verichron/contracts';
import type { AppSettings } from '../shared/types/window';

/**
 * The examiner's settings (EPOCH-560): one JSON file in the app's settings
 * folder (Electron's userData), read and written only by the main process,
 * as the folders pulls wrote to are (`device-pull-destinations.json`). They
 * belong to this installation, not to a case: nothing in them is evidence,
 * and the run records the zone it used (pipeline_runs.display_zone).
 *
 *   displayZone    the zone every time is shown in, in the app and in
 *                  reports: UTC (the default) or a named zone
 *   backupsFolder  the folder New Investigation last looked in for backups
 *
 * No file means the defaults. A file that can't be read as settings is an
 * error that names it, never silently replaced.
 */
export const SETTINGS_FILE = 'settings.json';

export const DEFAULT_SETTINGS: AppSettings = { displayZone: DEFAULT_DISPLAY_ZONE, backupsFolder: null };

const KEYS = Object.keys(DEFAULT_SETTINGS);

function parseSettings(text: string, file: string): AppSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} does not hold settings.`);
  }
  const record = parsed as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !KEYS.includes(key));
  if (unknown.length) throw new Error(`${file} has settings Epoch doesn't know: ${unknown.join(', ')}.`);
  const settings = { ...DEFAULT_SETTINGS, ...record };
  if (typeof settings.displayZone !== 'string' || !isDisplayZone(settings.displayZone)) {
    throw new Error(
      `${file}: displayZone must be UTC or a named time zone, not ${JSON.stringify(record.displayZone)}.`
    );
  }
  if (
    settings.backupsFolder !== null &&
    (typeof settings.backupsFolder !== 'string' || !path.isAbsolute(settings.backupsFolder))
  ) {
    throw new Error(`${file}: backupsFolder must be a folder's full path or null.`);
  }
  return settings as AppSettings;
}

export async function readSettings(settingsDir: string): Promise<AppSettings> {
  const file = path.join(settingsDir, SETTINGS_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw err;
  }
  return parseSettings(text, file);
}

/** Changes some settings, checked as a whole before anything is written; the file is replaced atomically. */
export async function updateSettings(settingsDir: string, change: Partial<AppSettings>): Promise<AppSettings> {
  const file = path.join(settingsDir, SETTINGS_FILE);
  const next = parseSettings(JSON.stringify({ ...(await readSettings(settingsDir)), ...change }), file);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(settingsDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n');
  await fs.rename(tmp, file);
  return next;
}
