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
