import fs from 'fs';
import type { GuidedToolSetup } from '../../../../../shared/types/tools';
import { buildToolchain } from './build';
import { installSystemRequirements } from './install';
import { PINNED_COMPONENTS } from './pins';
import { run } from './process';
import { checkRequirements, type SetupContext } from './requirements';

export { manifestMatchesPins, readManifest } from './manifest';

/** Guided setup for iPhone import on Linux and macOS (EPOCH-465). */
export function guidedSetup(prefix: string, buildDir: string): GuidedToolSetup {
  const context = (): SetupContext => ({
    platform: process.platform,
    prefix,
    buildDir,
    components: PINNED_COMPONENTS,
    run,
    exists: (file) => fs.existsSync(file),
    osRelease: () => {
      try {
        return fs.readFileSync('/etc/os-release', 'utf-8');
      } catch {
        return null;
      }
    },
    env: process.env,
  });
  return {
    status: () => checkRequirements(context()),
    installRequirements: (emit) => installSystemRequirements(context(), emit),
    build: (emit) => buildToolchain(context(), emit),
  };
}
