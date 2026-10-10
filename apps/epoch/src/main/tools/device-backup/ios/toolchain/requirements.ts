import path from 'path';
import type { ToolSetupInstallPlan, ToolSetupRequirement, ToolSetupStatus } from '../../../../../shared/types/tools';
import type { PinnedComponent } from './pins';
import { manifestMatchesPins, readManifest, readProgress } from './manifest';
import type { Run } from './process';

/**
 * What iPhone import needs on this machine, and whether each is met
 * (EPOCH-465). The list comes from the pinned libraries' own configure.ac:
 * a C compiler and make; pkg-config, which every library after libplist uses
 * to find the others; OpenSSL headers (libimobiledevice's TLS); libcurl
 * headers (libtatsu); tar and bzip2 to unpack the releases; and, on Linux,
 * the usbmuxd service that talks to the device over USB (macOS has its own).
 */
export interface SetupContext {
  platform: NodeJS.Platform;
  /** Where the libraries install (the app's tools folder). */
  prefix: string;
  /** Scratch space for downloads and builds. */
  buildDir: string;
  /** The libraries to build; the pins, except in tests. */
  components: readonly PinnedComponent[];
  run: Run;
  exists: (file: string) => boolean;
  /** Contents of /etc/os-release, or null. */
  osRelease: () => string | null;
  env: NodeJS.ProcessEnv;
}

/** Debian/Ubuntu packages that provide every Linux requirement. */
export const APT_PACKAGES = ['build-essential', 'pkg-config', 'libssl-dev', 'libcurl4-openssl-dev', 'usbmuxd'];
/** Homebrew formulas for macOS; the compiler comes from Xcode Command Line Tools. */
export const BREW_FORMULAS = ['pkg-config', 'openssl@3', 'curl'];
const USBMUXD_PATHS = ['/usr/sbin/usbmuxd', '/usr/bin/usbmuxd', '/usr/local/sbin/usbmuxd'];
const MAC_BIN_PATHS = ['/opt/homebrew/bin', '/usr/local/bin'];

const firstLine = (text: string) => text.split('\n').find((l) => l.trim().length > 0)?.trim();

/** The environment builds and checks run in: the tools folder's own .pc
 * files first, and on macOS Homebrew's tools and its keg-only OpenSSL/curl. */
export function toolchainEnv(ctx: SetupContext, brewPrefix?: string): NodeJS.ProcessEnv {
  const pkgConfig = [path.join(ctx.prefix, 'lib', 'pkgconfig')];
  let pathVar = ctx.env.PATH ?? '';
  if (ctx.platform === 'darwin') {
    pathVar = [...MAC_BIN_PATHS, pathVar].filter(Boolean).join(':');
    if (brewPrefix) {
      pkgConfig.push(
        path.join(brewPrefix, 'opt', 'openssl@3', 'lib', 'pkgconfig'),
        path.join(brewPrefix, 'opt', 'curl', 'lib', 'pkgconfig')
      );
    }
  }
  return {
    ...ctx.env,
    PATH: pathVar,
    PKG_CONFIG_PATH: [...pkgConfig, ctx.env.PKG_CONFIG_PATH].filter(Boolean).join(path.delimiter),
  };
}

async function brewPrefixOf(ctx: SetupContext, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const brew = await ctx.run('brew', ['--prefix'], { env });
  return brew.code === 0 ? firstLine(brew.output) : undefined;
}

async function commandRequirement(
  ctx: SetupContext,
  env: NodeJS.ProcessEnv,
  id: string,
  label: string,
  command: string,
  args: string[],
  purpose: string
): Promise<ToolSetupRequirement> {
  const result = await ctx.run(command, args, { env });
  return result.code === 0
    ? { id, group: 'system', label, ok: true, version: firstLine(result.output), detail: purpose }
    : { id, group: 'system', label, ok: false, detail: `Not found. ${purpose}` };
}

async function pkgConfigRequirement(
  ctx: SetupContext,
  env: NodeJS.ProcessEnv,
  havePkgConfig: boolean,
  id: string,
  label: string,
  module: string,
  purpose: string
): Promise<ToolSetupRequirement> {
  if (!havePkgConfig) {
    return { id, group: 'system', label, ok: false, detail: `Can't be checked until pkg-config is installed. ${purpose}` };
  }
  const result = await ctx.run('pkg-config', ['--modversion', module], { env });
  return result.code === 0
    ? { id, group: 'system', label, ok: true, version: firstLine(result.output), detail: purpose }
    : { id, group: 'system', label, ok: false, detail: `Not found. ${purpose}` };
}

async function systemRequirements(ctx: SetupContext, env: NodeJS.ProcessEnv): Promise<ToolSetupRequirement[]> {
  const reqs: ToolSetupRequirement[] = [];
  if (ctx.platform === 'darwin') {
    const clt = await ctx.run('xcode-select', ['-p'], { env });
    reqs.push(
      clt.code === 0
        ? { id: 'clt', group: 'system', label: 'Xcode Command Line Tools', ok: true, detail: 'The C compiler and make.' }
        : { id: 'clt', group: 'system', label: 'Xcode Command Line Tools', ok: false, detail: 'Not installed. Provides the C compiler and make.' }
    );
    reqs.push(await commandRequirement(ctx, env, 'brew', 'Homebrew', 'brew', ['--version'], 'Installs the remaining tools.'));
  } else {
    reqs.push(await commandRequirement(ctx, env, 'cc', 'C compiler', 'cc', ['--version'], 'Compiles the libraries.'));
    reqs.push(await commandRequirement(ctx, env, 'make', 'make', 'make', ['--version'], 'Runs each library\'s build.'));
  }
  const pkgConfig = await commandRequirement(ctx, env, 'pkg-config', 'pkg-config', 'pkg-config', ['--version'], 'Lets each library find the others.');
  reqs.push(pkgConfig);
  reqs.push(await pkgConfigRequirement(ctx, env, pkgConfig.ok, 'openssl', 'OpenSSL development files', 'openssl', 'Secures the connection to the device.'));
  reqs.push(await pkgConfigRequirement(ctx, env, pkgConfig.ok, 'libcurl', 'libcurl development files', 'libcurl', 'Required by libtatsu.'));
  const bzip2 = await ctx.run('/bin/sh', ['-c', 'command -v tar && command -v bzip2'], { env });
  reqs.push({
    id: 'archive',
    group: 'system',
    label: 'tar and bzip2',
    ok: bzip2.code === 0,
    detail: bzip2.code === 0 ? 'Unpack the library releases.' : 'Not found. Unpack the library releases.',
  });
  return reqs;
}

async function serviceRequirements(ctx: SetupContext, env: NodeJS.ProcessEnv): Promise<ToolSetupRequirement[]> {
  if (ctx.platform === 'darwin') return []; // macOS runs its own usbmuxd
  const found = USBMUXD_PATHS.find((p) => ctx.exists(p));
  if (!found) {
    return [{ id: 'usbmuxd', group: 'service', label: 'usbmuxd', ok: false, detail: 'Not installed. Connects to the iPhone over USB.' }];
  }
  const version = await ctx.run(found, ['--version'], { env });
  return [{
    id: 'usbmuxd',
    group: 'service',
    label: 'usbmuxd',
    ok: true,
    version: version.code === 0 ? firstLine(version.output) : undefined,
    detail: 'Connects to the iPhone over USB.',
  }];
}

function libraryRequirements(ctx: SetupContext, installed: boolean): ToolSetupRequirement[] {
  const done = new Set(readProgress(ctx.buildDir, ctx.components).map((c) => c.name));
  return ctx.components.map((c) => ({
    id: c.name,
    group: 'libraries' as const,
    label: `${c.name} ${c.version}`,
    ok: installed,
    detail: installed
      ? 'Installed and verified.'
      : done.has(c.name)
        ? 'Built; the setup was interrupted before it finished.'
        : 'Not installed. Built from a verified release.',
  }));
}

function isDebianLike(osRelease: string | null): boolean {
  if (!osRelease) return false;
  const field = (key: string) => osRelease.match(new RegExp(`^${key}="?([^"\\n]*)"?$`, 'm'))?.[1] ?? '';
  return /\b(debian|ubuntu)\b/.test(`${field('ID')} ${field('ID_LIKE')}`);
}

function installPlan(ctx: SetupContext, missing: ToolSetupRequirement[], havePkexec: boolean): ToolSetupInstallPlan | null {
  if (missing.length === 0) return null;
  if (ctx.platform === 'darwin') {
    if (missing.some((r) => r.id === 'clt')) {
      return {
        packages: ['Xcode Command Line Tools'],
        command: 'xcode-select --install',
        automatic: true,
        note: "Apple's installer opens in its own window. Finish it there, then choose Check Again.",
      };
    }
    if (missing.some((r) => r.id === 'brew')) {
      return {
        packages: ['Homebrew'],
        command: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        automatic: false,
        note: 'Install Homebrew from brew.sh in Terminal, then choose Check Again.',
      };
    }
    return { packages: BREW_FORMULAS, command: `brew install ${BREW_FORMULAS.join(' ')}`, automatic: true };
  }
  const command = `sudo apt-get update && sudo apt-get install -y ${APT_PACKAGES.join(' ')}`;
  if (!isDebianLike(ctx.osRelease())) {
    return {
      packages: APT_PACKAGES,
      command,
      automatic: false,
      note: "Automatic install supports Debian and Ubuntu. On this distribution, install the equivalent packages with its package manager, then choose Check Again.",
    };
  }
  return {
    packages: APT_PACKAGES,
    command,
    automatic: havePkexec,
    note: havePkexec
      ? 'Epoch will ask for your administrator password to install these packages.'
      : 'Run this command in a terminal, then choose Check Again.',
  };
}

export async function checkRequirements(ctx: SetupContext): Promise<ToolSetupStatus> {
  if (ctx.platform !== 'linux' && ctx.platform !== 'darwin') {
    return {
      supported: false,
      requirements: [],
      systemReady: false,
      installed: false,
      install: null,
      canResume: false,
      unsupportedReason: 'Guided setup supports Linux and macOS.',
    };
  }
  const baseEnv = toolchainEnv(ctx);
  const env = ctx.platform === 'darwin' ? toolchainEnv(ctx, await brewPrefixOf(ctx, baseEnv)) : baseEnv;
  const system = [...(await systemRequirements(ctx, env)), ...(await serviceRequirements(ctx, env))];
  const installed = manifestMatchesPins(readManifest(ctx.prefix), ctx.components);
  const missing = system.filter((r) => !r.ok);
  const havePkexec = ctx.platform === 'linux' && (await ctx.run('/bin/sh', ['-c', 'command -v pkexec'], { env })).code === 0;
  return {
    supported: true,
    requirements: [...system, ...libraryRequirements(ctx, installed)],
    systemReady: missing.length === 0,
    installed,
    install: installPlan(ctx, missing, havePkexec),
    canResume: !installed && readProgress(ctx.buildDir, ctx.components).length > 0,
  };
}

export { brewPrefixOf };
