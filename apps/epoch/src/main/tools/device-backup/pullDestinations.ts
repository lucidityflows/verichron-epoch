import fs from 'fs/promises';
import path from 'path';

/**
 * The folders device pulls have written to (EPOCH-466), most recent first,
 * kept in the app's settings folder. A pull that doesn't finish leaves an
 * incomplete backup in its folder; this list lets the app find it after the
 * user has chosen a different folder.
 */
export const PULL_DESTINATIONS_FILE = 'device-pull-destinations.json';
const MAX_DESTINATIONS = 20;

export async function readPullDestinations(settingsDir: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(settingsDir, PULL_DESTINATIONS_FILE), 'utf-8'));
    if (!Array.isArray(parsed) || !parsed.every((d) => typeof d === 'string')) {
      throw new Error(`${PULL_DESTINATIONS_FILE} is not a list of folders.`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function addPullDestination(settingsDir: string, destDir: string): Promise<void> {
  const known = await readPullDestinations(settingsDir);
  const next = [destDir, ...known.filter((d) => d !== destDir)].slice(0, MAX_DESTINATIONS);
  const file = path.join(settingsDir, PULL_DESTINATIONS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n');
  await fs.rename(tmp, file);
}

/** Forgets a folder a pull registered but never wrote to (a pull that could not start). */
export async function removePullDestination(settingsDir: string, destDir: string): Promise<void> {
  const known = await readPullDestinations(settingsDir);
  if (!known.includes(destDir)) return;
  const file = path.join(settingsDir, PULL_DESTINATIONS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(
    tmp,
    JSON.stringify(
      known.filter((d) => d !== destDir),
      null,
      2
    ) + '\n'
  );
  await fs.rename(tmp, file);
}

/**
 * The folder one pull writes into, inside the folder the examiner chose
 * (EPOCH-504): its UTC start time, e.g. `2026-10-14T130512Z`. Every pull gets
 * its own, so a pull never meets an existing backup and two pulls of one
 * device are listed under different names. Sortable, and safe on every
 * platform (no colons).
 */
export function pullFolderName(at: Date): string {
  return at
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '');
}
