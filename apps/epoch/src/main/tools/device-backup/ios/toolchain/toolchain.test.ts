/**
 * Guided iPhone tool setup (EPOCH-465): requirement checks, the admin-prompt
 * install, and the verified, resumable build. Commands run through a stub
 * that answers like a machine with a chosen set of tools; downloads write
 * fixed bytes whose hashes the test pins.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { ToolSetupEvent } from '../../../../../shared/types/tools';
import { buildToolchain, type Download } from './build';
import { adminPromptHint, hintFor } from './hints';
import { installSystemRequirements } from './install';
import { MANIFEST_FILE, PROGRESS_FILE, readManifest } from './manifest';
import type { PinnedComponent } from './pins';
import type { Run, RunOptions } from './process';
import { APT_PACKAGES, checkRequirements, type SetupContext } from './requirements';

const DEBIAN = 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\n';
const ALL_TOOLS = ['cc', 'make', 'pkg-config', 'openssl', 'libcurl', 'tar', 'bzip2', 'pkexec'];

interface Call {
  command: string;
  args: string[];
  cwd?: string;
}

/** A machine with `tools` installed; `extra` answers anything else first. */
function machine(tools: string[], extra?: (call: Call, options: RunOptions) => { code: number; output: string } | undefined) {
  const calls: Call[] = [];
  const has = (name: string) => tools.includes(name);
  const runStub: Run = async (command, args, options = {}) => {
    const call = { command, args, cwd: options.cwd };
    calls.push(call);
    const answer = extra?.(call, options);
    if (answer) {
      options.onOutput?.(answer.output);
      return answer;
    }
    if (command === '/bin/sh') {
      const names = [...args[1].matchAll(/command -v (\S+)/g)].map((m) => m[1]);
      return { code: names.every(has) ? 0 : 1, output: '' };
    }
    if (command === 'pkg-config' && args[0] === '--modversion') {
      return has('pkg-config') && has(args[1]) ? { code: 0, output: '3.5.0\n' } : { code: 1, output: `Package ${args[1]} was not found` };
    }
    if (['cc', 'make', 'pkg-config'].includes(command)) {
      return has(command) ? { code: 0, output: `${command} 1.0\n` } : { code: 127, output: `${command}: not found\n` };
    }
    return { code: 127, output: `${command}: not found\n` };
  };
  return { run: runStub, calls };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function context(run: Run, overrides: Partial<SetupContext> = {}): SetupContext {
  return {
    platform: 'linux',
    prefix: path.join(root, 'prefix'),
    buildDir: path.join(root, 'build'),
    components: [],
    run,
    exists: (file) => file === '/usr/sbin/usbmuxd',
    osRelease: () => DEBIAN,
    env: { PATH: '/usr/bin' },
    ...overrides,
  };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function component(name: string, version = '1.0.0'): PinnedComponent {
  return { name, version, url: `https://example.invalid/${name}`, sha256: sha(`${name}-${version}`), configureArgs: [] };
}
/** Writes each component's expected bytes, or `override` for a named one. */
const downloads = (override: Record<string, string> = {}): Download => async (url, dest) => {
  const name = url.split('/').pop()!;
  fs.writeFileSync(dest, override[name] ?? `${name}-1.0.0`);
};

/** Build commands: tar creates the source directory; configure and make succeed unless `fail` says otherwise. */
function builds(fail?: (call: Call) => string | undefined, version = '1.0.0') {
  return (call: Call): { code: number; output: string } | undefined => {
    if (call.command === 'tar') {
      const archive = path.basename(call.args[1]).replace('.tar.bz2', '');
      fs.mkdirSync(path.join(call.args[3], archive), { recursive: true });
      return { code: 0, output: '' };
    }
    if (call.command === './configure' || call.command === 'make') {
      const failure = fail?.(call);
      return failure ? { code: 1, output: failure } : { code: 0, output: 'ok\n' };
    }
    if (call.command.endsWith(path.join('bin', 'idevicebackup2'))) {
      return { code: 0, output: `idevicebackup2 ${version}\n` };
    }
    return undefined;
  };
}

describe('requirements', () => {
  it('lists what is missing on a bare Debian machine and offers the admin-prompt install', async () => {
    const { run } = machine(['make', 'tar', 'bzip2', 'pkexec']);
    const status = await checkRequirements(context(run, { exists: () => false }));
    const missing = status.requirements.filter((r) => !r.ok && r.group !== 'libraries').map((r) => r.id);
    assert.deepEqual(missing, ['cc', 'pkg-config', 'openssl', 'libcurl', 'usbmuxd']);
    assert.equal(status.systemReady, false);
    assert.equal(status.install?.automatic, true);
    assert.deepEqual(status.install?.packages, APT_PACKAGES);
    assert.match(status.install!.note!, /administrator password/);
  });

  it('can only show the command on a non-Debian distribution, or without pkexec', async () => {
    const fedora = await checkRequirements(context(machine(['make']).run, { osRelease: () => 'ID=fedora\n' }));
    assert.equal(fedora.install?.automatic, false);
    const noPkexec = await checkRequirements(context(machine(['make']).run));
    assert.equal(noPkexec.install?.automatic, false);
  });

  it('is ready to build when every system requirement is met, and installed only with a matching manifest', async () => {
    const components = [component('libplist')];
    const ctx = context(machine(ALL_TOOLS).run, { components });
    const ready = await checkRequirements(ctx);
    assert.equal(ready.systemReady, true);
    assert.equal(ready.install, null);
    assert.equal(ready.installed, false);

    fs.mkdirSync(ctx.prefix, { recursive: true });
    fs.writeFileSync(
      path.join(ctx.prefix, MANIFEST_FILE),
      JSON.stringify({ schema_version: 1, components: [{ name: 'libplist', version: '1.0.0', sha256: components[0].sha256 }] })
    );
    assert.equal((await checkRequirements(ctx)).installed, true);
    assert.equal((await checkRequirements({ ...ctx, components: [component('libplist', '2.0.0')] })).installed, false, 'a different pin is not installed');
  });

  it('on macOS, offers Apple\'s Command Line Tools installer first', async () => {
    const status = await checkRequirements(context(machine([]).run, { platform: 'darwin' }));
    assert.equal(status.install?.command, 'xcode-select --install');
    assert.ok(!status.requirements.some((r) => r.id === 'usbmuxd'), 'macOS has its own usbmuxd');
  });
});

describe('installing system tools', () => {
  it('runs apt-get once through pkexec, and reports a cancelled prompt plainly', async () => {
    const { run, calls } = machine(['make', 'pkexec'], (call) =>
      call.command === 'pkexec' ? { code: 126, output: 'Error executing command as another user: Request dismissed\n' } : undefined
    );
    const events: ToolSetupEvent[] = [];
    const result = await installSystemRequirements(context(run, { exists: () => false }), (e) => events.push(e));
    const pkexec = calls.filter((c) => c.command === 'pkexec');
    assert.equal(pkexec.length, 1, 'one administrator prompt');
    assert.match(pkexec[0].args.join(' '), /apt-get update && apt-get install -y build-essential pkg-config libssl-dev libcurl4-openssl-dev usbmuxd/);
    assert.equal(result.success, false);
    assert.equal(result.failure?.hint, 'The administrator request was cancelled.');
    assert.deepEqual(events.at(-1), { type: 'step', id: 'system', status: 'failed' });
  });
});

describe('building the libraries', () => {
  const components = [component('libplist'), component('libimobiledevice-glue'), component('libimobiledevice')];

  it('refuses a download whose SHA-256 differs, and keeps nothing from it', async () => {
    const { run } = machine(ALL_TOOLS, builds());
    const ctx = context(run, { components });
    const result = await buildToolchain(ctx, () => undefined, downloads({ libplist: 'tampered' }));
    assert.equal(result.success, false);
    assert.equal(result.failure?.label, 'Verify libplist 1.0.0');
    assert.match(result.failure!.tail[0], /SHA-256 mismatch/);
    assert.match(result.failure!.hint!, /checksum/);
    assert.deepEqual(fs.readdirSync(path.join(ctx.buildDir, 'downloads')), []);
    assert.equal(readManifest(ctx.prefix), null);
  });

  it('builds every component in order, verifies, and only then writes the manifest', async () => {
    const { run, calls } = machine(ALL_TOOLS, builds());
    const ctx = context(run, { components });
    const events: ToolSetupEvent[] = [];
    const result = await buildToolchain(ctx, (e) => events.push(e), downloads());
    assert.equal(result.success, true, JSON.stringify(result));

    const configured = calls.filter((c) => c.command === './configure').map((c) => path.basename(c.cwd!));
    assert.deepEqual(configured, ['libplist-1.0.0', 'libimobiledevice-glue-1.0.0', 'libimobiledevice-1.0.0']);
    assert.ok(calls.some((c) => c.command === './configure' && c.args[0] === `--prefix=${ctx.prefix}`));
    assert.deepEqual(readManifest(ctx.prefix)?.components.map((c) => c.name), components.map((c) => c.name));
    assert.ok(!fs.existsSync(path.join(ctx.buildDir, PROGRESS_FILE)));
    const plan = events.find((e) => e.type === 'plan');
    assert.equal(plan?.type === 'plan' && plan.steps.at(-1)?.label, 'Verify the installation');
    assert.ok(events.some((e) => e.type === 'step' && e.id === 'verify' && e.status === 'done'));
  });

  it('names a failed step with its output and cause, then resumes from it on retry', async () => {
    let configureGlueFails = true;
    const { run } = machine(
      ALL_TOOLS,
      builds((call) =>
        configureGlueFails && call.command === './configure' && call.cwd!.endsWith('libimobiledevice-glue-1.0.0')
          ? "checking for libcurl... no\nconfigure: error: Package requirements (libcurl >= 7.0) were not met:\n\nPackage 'libcurl', required by 'virtual:world', not found\n"
          : undefined
      )
    );
    const ctx = context(run, { components });
    const first = await buildToolchain(ctx, () => undefined, downloads());
    assert.equal(first.success, false);
    assert.equal(first.failure?.stepId, 'libimobiledevice-glue');
    assert.equal(first.failure?.label, 'Configure libimobiledevice-glue 1.0.0');
    assert.match(first.failure!.hint!, /libcurl development files aren't installed/);
    assert.ok(first.failure!.tail.some((l) => l.includes('not found')));
    assert.equal((await checkRequirements(ctx)).canResume, true);

    configureGlueFails = false;
    const events: ToolSetupEvent[] = [];
    const second = await buildToolchain(ctx, (e) => events.push(e), downloads());
    assert.equal(second.success, true);
    assert.ok(events.some((e) => e.type === 'step' && e.id === 'libplist' && e.status === 'skipped'), 'libplist was not rebuilt');
    assert.ok(readManifest(ctx.prefix));
  });

  it('fails verification when idevicebackup2 does not report the pinned version', async () => {
    const { run } = machine(ALL_TOOLS, builds(undefined, '9.9.9'));
    const ctx = context(run, { components });
    const result = await buildToolchain(ctx, () => undefined, downloads());
    assert.equal(result.failure?.stepId, 'verify');
    assert.equal(readManifest(ctx.prefix), null, 'an unverified build is never marked installed');
  });

  it('does not start without the system tools', async () => {
    const { run, calls } = machine(['make']);
    const result = await buildToolchain(context(run, { components }), () => undefined, downloads());
    assert.equal(result.failure?.stepId, 'requirements');
    assert.match(result.failure!.hint!, /C compiler, pkg-config/);
    assert.ok(!calls.some((c) => c.command === 'tar' || c.command === './configure'));
  });
});

describe('failure hints', () => {
  for (const [line, expected] of [
    ['configure: error: The pkg-config script could not be found or is too old.', /pkg-config isn't installed/],
    ["No package 'openssl' found", /OpenSSL development files/],
    ['configure: error: C compiler cannot create executables', /C compiler/],
    ['E: Could not get lock /var/lib/dpkg/lock-frontend', /Another program is installing/],
    ['E: Unable to locate package libtatsu-dev', /doesn't know libtatsu-dev/],
  ] as const) {
    it(`explains: ${line}`, () => assert.match(hintFor([line])!, expected));
  }

  it('says nothing rather than guess', () => assert.equal(hintFor(['make[2]: *** [Makefile:400: all] Error 2']), undefined));

  it('reads pkexec exit codes', () => {
    assert.equal(adminPromptHint(126), 'The administrator request was cancelled.');
    assert.equal(adminPromptHint(1), undefined);
  });
});
