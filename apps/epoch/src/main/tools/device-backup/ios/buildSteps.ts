import path from 'path';
import type { ToolAcquisitionCommand } from '../../../../shared/types/tools';

/**
 * Real build sequence, sourced from libimobiledevice/libimobiledevice's own
 * README (fetched directly, not guessed) plus its Debian/Ubuntu dependency
 * list. Building the full chain from source -- not relying on distro
 * packages for libplist/libusbmuxd/libimobiledevice-glue/libtatsu -- is
 * deliberate: distro package versions lag, and the whole point of this
 * path is getting current iOS/device compatibility, which is exactly what
 * stale distro-packaged versions can't guarantee.
 *
 * Dependency order matters and is fixed: libplist and libimobiledevice-glue
 * have no dependency on each other and could build in either order, but
 * libusbmuxd depends on libplist, libtatsu depends on nothing else in this
 * chain, and libimobiledevice depends on all four. Listed in an order that
 * satisfies all of that.
 *
 * Everything installs to `installPrefix` (an app-owned directory, not
 * /usr/local) specifically so this never needs sudo/pkexec/administrator
 * elevation -- only the one apt/brew step below (real system packages,
 * genuinely can't be redirected to a user prefix) needs that, and it's
 * handled separately as an install-instructions action the user runs once,
 * not part of this automated sequence.
 */

interface SourceRepo {
  name: string;
  gitUrl: string;
}

const REPOS_IN_DEPENDENCY_ORDER: SourceRepo[] = [
  { name: 'libplist', gitUrl: 'https://github.com/libimobiledevice/libplist.git' },
  { name: 'libimobiledevice-glue', gitUrl: 'https://github.com/libimobiledevice/libimobiledevice-glue.git' },
  { name: 'libusbmuxd', gitUrl: 'https://github.com/libimobiledevice/libusbmuxd.git' },
  { name: 'libtatsu', gitUrl: 'https://github.com/libimobiledevice/libtatsu.git' },
  { name: 'libimobiledevice', gitUrl: 'https://github.com/libimobiledevice/libimobiledevice.git' },
];

/** Windows: the build tools WSL needs, shown to the user as one line to
 * run themselves. Linux and macOS use the guided setup's own requirement
 * checks and install instead (toolchain/requirements.ts, EPOCH-465). */
export function systemPackageInstallCommand(platform: NodeJS.Platform): string {
  if (platform !== 'win32') {
    throw new Error('systemPackageInstallCommand is for the Windows (WSL) path; Linux and macOS use guided setup');
  }
  return 'wsl -- bash -lc "sudo apt-get install -y build-essential pkg-config checkinstall git autoconf automake libtool-bin libssl-dev usbmuxd"';
}

/** Full automated build sequence -- clone, autogen, make, make install
 * (to installPrefix, no sudo) -- for each repo in dependency order. `buildDir`
 * is a scratch directory the caller creates and can discard afterward;
 * `installPrefix` is where the resulting binaries/libraries end up, and
 * should be the same path detectBinary() is later given as its bundled-path
 * check. */
export function compileFromSourceSteps(buildDir: string, installPrefix: string): ToolAcquisitionCommand[] {
  const steps: ToolAcquisitionCommand[] = [];
  // Each repo after the first needs the previous ones' .pc files on
  // PKG_CONFIG_PATH to find them at installPrefix rather than system
  // locations -- autogen.sh reads this from the environment, not as a
  // configure flag, so it's threaded through via env on each command
  // rather than an arg here (main.ts's spawn wiring sets this per-step).

  for (const repo of REPOS_IN_DEPENDENCY_ORDER) {
    steps.push({
      label: `Fetch ${repo.name} source`,
      command: 'git',
      args: ['clone', '--depth', '1', repo.gitUrl, repo.name],
      cwd: buildDir,
    });
    steps.push({
      label: `Configure ${repo.name}`,
      command: './autogen.sh',
      args: [`--prefix=${installPrefix}`],
      cwd: path.join(buildDir, repo.name),
    });
    steps.push({
      label: `Build ${repo.name}`,
      command: 'make',
      args: [],
      cwd: path.join(buildDir, repo.name),
    });
    steps.push({
      label: `Install ${repo.name}`,
      command: 'make',
      args: ['install'],
      cwd: path.join(buildDir, repo.name),
    });
  }

  return steps;
}

/** Windows path: delegate the exact same Linux sequence to WSL rather than
 * attempt a native MSYS2 build. MSYS2 is a real, documented alternative
 * (per the project's own build docs) but managing an MSYS2 environment
 * from Electron is meaningfully more scope than wrapping WSL, which most
 * developer-oriented Windows machines already have. Native MSYS2 support
 * is a reasonable follow-up, not part of this pass. */
export function compileFromSourceStepsViaWsl(buildDir: string, installPrefix: string): ToolAcquisitionCommand[] {
  const toWslPath = (p: string) => `/mnt/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}`;
  const wslBuildDir = toWslPath(buildDir);
  const wslInstallPrefix = toWslPath(installPrefix);

  const linuxSteps = compileFromSourceSteps(wslBuildDir, wslInstallPrefix);
  return linuxSteps.map((step) => ({
    label: `${step.label} (WSL)`,
    command: 'wsl.exe',
    args: ['--', 'bash', '-lc', `cd '${step.cwd}' && ${step.command} ${step.args.join(' ')}`],
  }));
}
