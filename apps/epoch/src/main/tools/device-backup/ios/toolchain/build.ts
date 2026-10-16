import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ToolSetupEvent, ToolSetupResult, ToolSetupStep } from '../../../../../shared/types/tools';
import { hintFor } from './hints';
import {
  PROGRESS_FILE,
  componentInstalled,
  readProgress,
  writeManifest,
  writeProgress,
  type BuiltComponent,
} from './manifest';
import { archiveName, sourceDirName, type PinnedComponent } from './pins';
import { lastLines } from './process';
import { brewPrefixOf, checkRequirements, toolchainEnv, type SetupContext } from './requirements';

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Saves `url` to `dest`. Rejects on any HTTP, network or timeout failure (EPOCH-468). */
export type Download = (url: string, dest: string, timeoutMs?: number) => Promise<void>;

/**
 * Saves the response body to `dest`, overwriting an existing file. `timeoutMs`
 * limits the request and body transfer together, in milliseconds (default 60,000).
 * Rejects on an invalid timeout, HTTP failure or missing body, network error,
 * timeout, or file write error. A failed transfer can leave a partial file;
 * cleanup is the caller's responsibility.
 */
export const download: Download = async (url, dest, timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS) => {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} downloading ${url}`);
  await pipeline(Readable.fromWeb(response.body as import('stream/web').ReadableStream), fs.createWriteStream(dest), {
    signal,
  });
};

export async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

const VERIFY_STEP = 'verify';

class StepFailure extends Error {
  constructor(
    readonly label: string,
    readonly tail: string[],
    readonly hint?: string
  ) {
    super(label);
  }
}

/**
 * Builds the pinned libraries into the tools folder (EPOCH-465). For each
 * component: download the release (kept if its SHA-256 already matches),
 * verify it, extract it fresh, then configure, make and make install. Each
 * finished component is recorded. A retry resumes only while all recorded
 * components have matching pkg-config entries; otherwise it starts from an
 * empty tools folder, retaining cached downloads. Last, `idevicebackup2 --version`
 * must succeed and its output contain the last component's pinned version;
 * only then is the manifest written that marks the libraries installed.
 *
 * Reports progress through `emit`. Returns a failure result for unmet system
 * requirements, download errors, checksum mismatches, failed build commands,
 * or failed version verification. Failed downloads and checksum mismatches
 * remove the partial archive. Other errors, including filesystem errors and
 * errors thrown by `emit`, reject the promise.
 */
export async function buildToolchain(
  ctx: SetupContext,
  emit: (event: ToolSetupEvent) => void,
  fetchTo: Download = download
): Promise<ToolSetupResult> {
  const status = await checkRequirements(ctx);
  if (!status.systemReady) {
    const missing = status.requirements.filter((r) => r.group !== 'libraries' && !r.ok).map((r) => r.label);
    return {
      success: false,
      failure: {
        stepId: 'requirements',
        label: 'Check requirements',
        hint: `Install the system tools first: ${missing.join(', ')}.`,
        tail: [],
      },
    };
  }

  const env = toolchainEnv(ctx, ctx.platform === 'darwin' ? await brewPrefixOf(ctx, toolchainEnv(ctx)) : undefined);
  const downloads = path.join(ctx.buildDir, 'downloads');
  const sources = path.join(ctx.buildDir, 'src');

  let done = readProgress(ctx.buildDir, ctx.components);
  if (done.some((d) => !componentInstalled(ctx.prefix, d.name))) {
    done = [];
  }
  if (done.length === 0) {
    // A fresh build: nothing half-installed or left over may remain. Verified
    // downloads are kept; their hashes are checked again before use.
    fs.rmSync(ctx.prefix, { recursive: true, force: true });
    for (const entry of fs.existsSync(ctx.buildDir) ? fs.readdirSync(ctx.buildDir) : []) {
      if (entry !== 'downloads') fs.rmSync(path.join(ctx.buildDir, entry), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(ctx.prefix, { recursive: true });
  fs.mkdirSync(downloads, { recursive: true });
  fs.mkdirSync(sources, { recursive: true });

  const label = (c: PinnedComponent) => `${c.name} ${c.version}`;
  const steps: ToolSetupStep[] = [
    ...ctx.components.map((c) => ({ id: c.name, label: label(c), status: 'pending' as const })),
    { id: VERIFY_STEP, label: 'Verify the installation', status: 'pending' },
  ];
  emit({ type: 'plan', steps });

  const jobs = String(Math.max(1, os.cpus().length));
  let current = '';
  try {
    for (const component of ctx.components) {
      current = component.name;
      if (done.some((d) => d.name === component.name)) {
        if (!componentInstalled(ctx.prefix, component.name)) {
          done = [];
          fs.rmSync(ctx.prefix, { recursive: true, force: true });
        } else {
          emit({ type: 'step', id: component.name, status: 'skipped', detail: 'Built in an earlier attempt' });
          continue;
        }
      }
      const phase = (detail: string) => emit({ type: 'step', id: component.name, status: 'running', detail });
      const runPhase = async (verb: string, command: string, args: string[], cwd: string) => {
        phase(`${verb}…`);
        const result = await ctx.run(command, args, {
          cwd,
          env,
          onOutput: (text) => {
            for (const line of text.split('\n')) if (line.trim()) emit({ type: 'output', id: component.name, line });
          },
        });
        if (result.code !== 0) {
          const tail = lastLines(result.output);
          throw new StepFailure(`${verb} ${label(component)}`, tail, hintFor(tail));
        }
      };

      phase('Downloading…');
      const archive = path.join(downloads, archiveName(component));
      if (!fs.existsSync(archive) || (await sha256Of(archive)) !== component.sha256) {
        const partial = `${archive}.part`;
        try {
          await fetchTo(component.url, partial);
        } catch (err) {
          fs.rmSync(partial, { force: true });
          const message = err instanceof Error ? err.message : String(err);
          throw new StepFailure(`Download ${label(component)}`, [message], hintFor([message]));
        }
        const actual = await sha256Of(partial);
        if (actual !== component.sha256) {
          fs.rmSync(partial, { force: true });
          const line = `SHA-256 mismatch for ${archiveName(component)}: expected ${component.sha256}, got ${actual}`;
          throw new StepFailure(`Verify ${label(component)}`, [line], hintFor([line]));
        }
        fs.renameSync(partial, archive);
      }

      const src = path.join(sources, sourceDirName(component));
      fs.rmSync(src, { recursive: true, force: true });
      await runPhase('Extract', 'tar', ['-xjf', archive, '-C', sources], sources);
      await runPhase('Configure', './configure', [`--prefix=${ctx.prefix}`, ...component.configureArgs], src);
      await runPhase('Build', 'make', ['-j', jobs], src);
      await runPhase('Install', 'make', ['install'], src);

      const built: BuiltComponent = { name: component.name, version: component.version, sha256: component.sha256 };
      done = [...done, built];
      writeProgress(ctx.buildDir, done);
      emit({ type: 'step', id: component.name, status: 'done' });
    }

    current = VERIFY_STEP;
    emit({ type: 'step', id: VERIFY_STEP, status: 'running', detail: 'Running idevicebackup2…' });
    const binary = path.join(ctx.prefix, 'bin', 'idevicebackup2');
    const check = await ctx.run(binary, ['--version'], { env });
    const expected = ctx.components[ctx.components.length - 1].version;
    if (check.code !== 0 || !check.output.includes(expected)) {
      const tail = lastLines(check.output);
      throw new StepFailure(
        'Verify the installation',
        tail,
        hintFor(tail) ?? `idevicebackup2 didn't report version ${expected}.`
      );
    }
    writeManifest(ctx.prefix, {
      schema_version: 1,
      components: done,
      built_at: new Date().toISOString(),
      platform: ctx.platform,
      arch: os.arch(),
      verified_with: check.output.trim().split('\n')[0],
    });
    emit({ type: 'step', id: VERIFY_STEP, status: 'done' });
    // The verified downloads stay for a later rebuild; sources and progress don't.
    fs.rmSync(sources, { recursive: true, force: true });
    fs.rmSync(path.join(ctx.buildDir, PROGRESS_FILE), { force: true });
    return { success: true };
  } catch (err) {
    if (!(err instanceof StepFailure)) throw err;
    emit({ type: 'step', id: current, status: 'failed' });
    return { success: false, failure: { stepId: current, label: err.label, hint: err.hint, tail: err.tail } };
  }
}
