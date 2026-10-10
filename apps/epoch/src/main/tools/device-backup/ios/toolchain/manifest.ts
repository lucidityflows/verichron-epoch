import fs from 'fs';
import path from 'path';
import { PINNED_COMPONENTS, type PinnedComponent } from './pins';

/**
 * What a finished build installed (EPOCH-465). Written last, after the build
 * is verified, so a half-finished install never reads as installed: the
 * libraries count as installed only when this file lists exactly the pinned
 * components.
 */
export const MANIFEST_FILE = 'toolchain.json';
/** In the build directory: components finished by an interrupted build. */
export const PROGRESS_FILE = 'progress.json';

export interface BuiltComponent {
  name: string;
  version: string;
  sha256: string;
}

export interface ToolchainManifest {
  schema_version: 1;
  components: BuiltComponent[];
  built_at: string;
  platform: string;
  arch: string;
  /** `idevicebackup2 --version`, recorded after the build was verified. */
  verified_with: string;
}

const sameComponent = (a: BuiltComponent, b: PinnedComponent) =>
  a.name === b.name && a.version === b.version && a.sha256 === b.sha256;

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function readManifest(prefix: string): ToolchainManifest | null {
  return readJson<ToolchainManifest>(path.join(prefix, MANIFEST_FILE));
}

/** True when the prefix holds exactly the pinned components, verified. */
export function manifestMatchesPins(
  manifest: ToolchainManifest | null,
  pins: readonly PinnedComponent[] = PINNED_COMPONENTS
): boolean {
  return (
    manifest?.schema_version === 1 &&
    manifest.components.length === pins.length &&
    pins.every((pin, i) => sameComponent(manifest.components[i], pin))
  );
}

export function writeManifest(prefix: string, manifest: ToolchainManifest): void {
  const file = path.join(prefix, MANIFEST_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Components an interrupted build finished, in pin order; empty if none or stale. */
export function readProgress(buildDir: string, pins: readonly PinnedComponent[] = PINNED_COMPONENTS): BuiltComponent[] {
  const done = readJson<BuiltComponent[]>(path.join(buildDir, PROGRESS_FILE)) ?? [];
  const valid: BuiltComponent[] = [];
  for (const [i, pin] of pins.entries()) {
    if (!done[i] || !sameComponent(done[i], pin)) break;
    valid.push(done[i]);
  }
  return valid;
}

export function writeProgress(buildDir: string, done: BuiltComponent[]): void {
  fs.writeFileSync(path.join(buildDir, PROGRESS_FILE), JSON.stringify(done, null, 2) + '\n');
}
