import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { IleappParams, ToolVersion } from '@verichron/contracts';

import { closeWriteStream } from './fs.js';
import { lineReader } from './lines.js';
import { killProcessGroup, trackProcessGroup } from './processGroup.js';

/**
 * Running iLEAPP over a decrypt, the processor's third derivative (EPOCH-416).
 *
 * iLEAPP is the git submodule at tools/ileapp/iLEAPP, run with the interpreter
 * of its own pinned environment, tools/ileapp/.venv (EPOCH-458).
 */

const run = promisify(execFile);

/**
 * iLEAPP's identity is the submodule commit, not its self-reported version
 * (version_info.py says 2026.3.0 at tag v2026.3.1). A checkout with local
 * changes is refused: its commit would not describe the code that ran.
 */
export async function ileappToolVersion(ileappDir: string): Promise<ToolVersion> {
  let commit: string;
  let changes: string;
  try {
    commit = (await run('git', ['-C', ileappDir, 'rev-parse', 'HEAD'])).stdout.trim();
    changes = (await run('git', ['-C', ileappDir, 'status', '--porcelain'])).stdout.trim();
  } catch (err) {
    throw new Error(
      `could not read the iLEAPP commit from ${ileappDir} (${err instanceof Error ? err.message : err}); ` +
        'run `mise run setup` to initialize the submodule'
    );
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`${ileappDir} reports "${commit}" as its commit; expected a 40-character git hash`);
  }
  if (changes) {
    throw new Error(
      `${ileappDir} has local changes, so its commit does not describe the code that would run; ` +
        `restore it with \`git -C ${ileappDir} checkout -- . && git -C ${ileappDir} clean -fd\``
    );
  }
  return { name: 'iLEAPP', version: commit };
}

/**
 * How iLEAPP should walk a decrypt (its -t). Only the decrypt's own top level
 * is checked: a Manifest.db or Info.plist somewhere deeper is a file inside
 * the backup, not a sign of what the backup is.
 */
export function ileappInputType(decryptedDir: string): IleappParams['input_type'] {
  if (fs.existsSync(path.join(decryptedDir, 'Manifest.db'))) return 'itunes';
  if (fs.existsSync(path.join(decryptedDir, 'Info.plist'))) return 'fs';
  throw new Error(
    `${decryptedDir} has no Manifest.db or Info.plist at its top level; it is not a backup iLEAPP can read`
  );
}

export interface IleappRun {
  python: string;
  ileappDir: string;
  decryptedDir: string;
  inputType: IleappParams['input_type'];
  /** Created by iLEAPP; must not exist yet. */
  outputDir: string;
  logPath: string;
  /** Where each module's timing is written as JSON, whether the run finishes or is stopped. */
  modulesPath: string;
  /** How long one phase (setup, one module, or the report) may run. */
  moduleTimeoutMs: number;
}

/** One iLEAPP module's run, as written to `modulesPath`. */
export interface IleappModuleRecord {
  index: number;
  total: number;
  name: string;
  module: string;
  started_at: string;
  finished_at: string | null;
  seconds: number | null;
  /** `unfinished`: iLEAPP exited or failed during this module, without completing it or being stopped. */
  status: 'completed' | 'stopped' | 'running' | 'unfinished';
}

type IleappPhase =
  { kind: 'setup' } | { kind: 'module'; record: IleappModuleRecord } | { kind: 'report' } | { kind: 'done' };

// iLEAPP's own lines (ileapp.py, crunch_artifacts).
const MODULE_STARTED = /^\[(\d+)\/(\d+)\] (.+) \[([^[\]]+)\] artifact started$/;
const MODULE_COMPLETED = /^(.+) \[([^[\]]+)\] artifact completed$/;
const MODULES_DONE = /^Processes completed\.$/;
const REPORT_DONE = /^Report generation Completed\.$/;

function formatLimit(ms: number): string {
  return ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

/**
 * Follows iLEAPP's output through its phases (setup, each module, then the
 * report) and records how long each module took (EPOCH-487). `line` returns
 * true when a new phase starts, which restarts the per-phase limit.
 */
export class IleappProgress {
  private phase: IleappPhase = { kind: 'setup' };
  private phaseStartedMs: number;
  private readonly startedMs: number;
  readonly modules: IleappModuleRecord[] = [];
  private setupSeconds: number | null = null;
  private reportSeconds: number | null = null;
  private stopped: string | null = null;

  constructor(nowMs: number) {
    this.startedMs = nowMs;
    this.phaseStartedMs = nowMs;
  }

  /** Reads one of iLEAPP's output lines; true when it starts a new phase. */
  line(raw: string, nowMs: number): boolean {
    const text = raw.trim();
    const started = MODULE_STARTED.exec(text);
    if (started) {
      this.endPhase(nowMs, 'completed');
      const record: IleappModuleRecord = {
        index: Number(started[1]),
        total: Number(started[2]),
        name: started[3],
        module: started[4],
        started_at: new Date(nowMs).toISOString(),
        finished_at: null,
        seconds: null,
        status: 'running',
      };
      this.modules.push(record);
      this.startPhase({ kind: 'module', record }, nowMs);
      return true;
    }
    const completed = MODULE_COMPLETED.exec(text);
    if (completed && this.phase.kind === 'module' && this.phase.record.module === completed[2]) {
      this.finish(this.phase.record, nowMs, 'completed');
      // The wait for the next module is timed too.
      return true;
    }
    if (MODULES_DONE.test(text)) {
      this.endPhase(nowMs, 'completed');
      this.startPhase({ kind: 'report' }, nowMs);
      return true;
    }
    if (REPORT_DONE.test(text) && this.phase.kind === 'report') {
      this.endPhase(nowMs, 'completed');
      // The wait for iLEAPP to exit is timed too.
      this.startPhase({ kind: 'done' }, nowMs);
      return true;
    }
    return false;
  }

  /** The current module, for progress: n of N and its name. */
  current(): IleappModuleRecord | null {
    return this.phase.kind === 'module' ? this.phase.record : null;
  }

  /** Records the current phase as stopped by the limit, and says what didn't run. */
  stop(nowMs: number, limitMs: number): string {
    const limit = formatLimit(limitMs);
    const phase = this.phase;
    let message: string;
    if (phase.kind === 'module') {
      const { index, total, name, module, status } = phase.record;
      const rest =
        index === total
          ? 'it was the last module'
          : index + 1 === total
            ? `module ${total} did not run`
            : `modules ${index + 1} to ${total} did not run`;
      message =
        status === 'completed'
          ? `iLEAPP stopped responding after module ${index} of ${total}, ${name} [${module}], completed: ` +
            `nothing followed within the ${limit} limit, so it was stopped; ${rest}`
          : `iLEAPP module ${index} of ${total}, ${name} [${module}], ran past the ${limit} limit and was stopped; ${rest}`;
    } else if (phase.kind === 'report') {
      message = `iLEAPP's report generation ran past the ${limit} limit and was stopped; every module had run`;
    } else if (phase.kind === 'done') {
      message =
        `iLEAPP wrote its report but did not exit within the ${limit} limit, so it was stopped; ` +
        'every module had run';
    } else {
      message = `iLEAPP's setup ran past the ${limit} limit and was stopped before any module ran`;
    }
    this.endPhase(nowMs, 'stopped');
    this.stopped = message;
    return message;
  }

  /** The record written when the run ends, whether it finished, failed or was stopped. */
  summary(nowMs: number, limitMs: number) {
    if (this.phase.kind === 'module' && this.phase.record.status === 'running') {
      this.finish(this.phase.record, nowMs, 'unfinished');
    }
    return {
      limit_seconds: Math.round(limitMs / 1000),
      total_seconds: Math.round((nowMs - this.startedMs) / 1000),
      setup_seconds: this.setupSeconds,
      report_seconds: this.reportSeconds,
      stopped: this.stopped,
      modules: this.modules,
    };
  }

  private startPhase(phase: IleappPhase, nowMs: number): void {
    this.phase = phase;
    this.phaseStartedMs = nowMs;
  }

  private endPhase(nowMs: number, status: 'completed' | 'stopped'): void {
    const seconds = Math.round((nowMs - this.phaseStartedMs) / 1000);
    if (this.phase.kind === 'setup') this.setupSeconds = seconds;
    else if (this.phase.kind === 'report') this.reportSeconds = seconds;
    else if (this.phase.kind === 'module' && this.phase.record.status === 'running') {
      this.finish(this.phase.record, nowMs, status);
    }
  }

  private finish(record: IleappModuleRecord, nowMs: number, status: 'completed' | 'stopped' | 'unfinished'): void {
    record.finished_at = new Date(nowMs).toISOString();
    record.seconds = Math.round((nowMs - Date.parse(record.started_at)) / 1000);
    record.status = status;
  }
}

/**
 * Runs iLEAPP so that its report is exactly `outputDir`: iLEAPP names its
 * report folder after --custom_output_folder inside -o, rather than the
 * timestamped iLEAPP_Output_<time> it would otherwise create.
 *
 * Output streams to the console line by line, and to `logPath` as written.
 * Each module, and the setup and report around them, may run for
 * `moduleTimeoutMs` (EPOCH-487): a slow run that keeps moving is never
 * stopped, while one stuck module is, with every process it started. iLEAPP
 * runs unbuffered, so each line arrives as it is printed. Each module's
 * timing is written to `modulesPath` either way.
 */
/**
 * iLEAPP's environment. Its output arrives a line at a time (EPOCH-487), and
 * its logarchive module never runs unifiedlog_iterator (EPOCH-489): iLEAPP
 * uses ILEAPP_UNIFIEDLOG_ITERATOR before any other location, and a value that
 * is not an executable file makes it log that and carry on without one.
 */
export const UNIFIEDLOG_ITERATOR_DISABLED = 'disabled-by-verichron';

export function ileappEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONUNBUFFERED: '1', ILEAPP_UNIFIEDLOG_ITERATOR: UNIFIEDLOG_ITERATOR_DISABLED };
}

export async function runIleapp(opts: IleappRun): Promise<void> {
  // iLEAPP runs from its checkout (cwd), so every path it is given must be
  // absolute; a relative one would resolve against the checkout instead. A
  // bare interpreter name stays a PATH lookup.
  const resolve = (p: string) => path.resolve(p);
  const python = opts.python.includes(path.sep) ? resolve(opts.python) : opts.python;
  const ileappDir = resolve(opts.ileappDir);
  const outputDir = resolve(opts.outputDir);
  const args = [
    path.join(ileappDir, 'ileapp.py'),
    '-t',
    opts.inputType,
    '-i',
    resolve(opts.decryptedDir),
    '-o',
    path.dirname(outputDir),
    '--custom_output_folder',
    path.basename(outputDir),
  ];
  await fsp.mkdir(path.dirname(outputDir), { recursive: true });
  const logStream = fs.createWriteStream(resolve(opts.logPath));
  const progress = new IleappProgress(Date.now());
  // Set by the limit or a log write failure, including one that only
  // surfaces when the log is flushed after iLEAPP has exited.
  let stopReason: Error | null = null;

  try {
    await new Promise<void>((resolveRun, reject) => {
      // Its own process group, so the limit or a failed log can stop
      // everything iLEAPP started; trackProcessGroup forwards a stop sent to
      // the processor.
      const child = spawn(python, args, {
        cwd: ileappDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: ileappEnv(),
      });
      const untrack = trackProcessGroup(child.pid);
      const stop = (reason: Error) => {
        if (stopReason) return;
        stopReason = reason;
        killProcessGroup(child.pid);
      };
      let timer: NodeJS.Timeout;
      const restartLimit = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => stop(new Error(progress.stop(Date.now(), opts.moduleTimeoutMs))),
          opts.moduleTimeoutMs
        );
      };
      restartLimit();

      // The log can fail to open, or fill the disk mid-run. Without this
      // listener Node would exit the whole processor; instead iLEAPP is
      // stopped and this backup fails.
      logStream.on('error', (err) => stop(new Error(`could not write the iLEAPP log ${opts.logPath}: ${err.message}`)));

      const onLine = (line: string) => {
        process.stdout.write(line + '\n');
        if (progress.line(line, Date.now())) {
          restartLimit();
          const current = progress.current();
          // The processor's own progress line, read by the app (EPOCH-487).
          if (current) console.log(`  [ileapp]  module ${current.index} of ${current.total}: ${current.name}`);
        }
      };
      const readers = [lineReader(onLine), lineReader(onLine)];
      [child.stdout, child.stderr].forEach((stream, i) =>
        stream.on('data', (chunk: Buffer) => {
          if (!logStream.destroyed) logStream.write(chunk);
          readers[i].push(chunk);
        })
      );
      child.on('error', (err) => {
        clearTimeout(timer);
        untrack();
        reject(stopReason ?? err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        untrack();
        readers.forEach((r) => r.end());
        if (stopReason) reject(stopReason);
        else if (code === 0) resolveRun();
        else reject(new Error(`iLEAPP exited with code ${code}`));
      });
    });
  } finally {
    await closeWriteStream(logStream);
    // The timings explain a run; they are not part of its output, so failing
    // to write them is reported but doesn't change the run's outcome.
    await fsp
      .writeFile(
        resolve(opts.modulesPath),
        JSON.stringify(progress.summary(Date.now(), opts.moduleTimeoutMs), null, 2) + '\n'
      )
      .catch((err) =>
        console.error(`  [ileapp]  could not write module timings to ${opts.modulesPath}: ${err.message}`)
      );
  }
  if (stopReason) throw stopReason;
  if (!fs.existsSync(outputDir)) {
    throw new Error(`iLEAPP exited cleanly but wrote no report at ${outputDir}`);
  }
}
