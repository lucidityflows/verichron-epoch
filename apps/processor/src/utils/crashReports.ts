import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  CRASH_REPORTS_MARKER,
  CrashReportsAcquisition,
  crashReportsAcquisitionPaths,
  readCrashReportsMarker,
  renderCrashReportsMarker,
} from '@verichron/contracts';
import { pathExists, writeFileAtomic } from './fs.js';
import { hashTree } from './manifest.js';

export type CrashReportsOutcome =
  { status: 'none'; message: string } | { status: 'reused' | 'copied'; files: number; reportsRoot: string };

/**
 * The device's crash logs, acquired by the pull beside this backup
 * (EPOCH-514), copied into <workspace>/crash_reports/<label>/ as a derivative
 * of the same evidence. The copy is hashed the way a backup is; its content
 * root is the derivative's identity, and it must match the pull's folder.
 * A folder without the pull's acquisition record is an unfinished copy and is
 * not used. Throws when the crash logs exist but can't be copied faithfully.
 */
export async function prepareCrashReports(opts: {
  backupPath: string;
  destDir: string;
  /** The backup's content root: the evidence the crash logs were acquired with. */
  contentRoot: string;
  force: boolean;
}): Promise<CrashReportsOutcome> {
  const { dir, record } = crashReportsAcquisitionPaths(opts.backupPath);
  if (!(await pathExists(record))) {
    return {
      status: 'none',
      message: (await pathExists(dir))
        ? `${dir} has no acquisition record (the copy didn't finish), so it is not used`
        : 'no crash logs were acquired with this backup',
    };
  }
  const acquisition = CrashReportsAcquisition.parse(JSON.parse(await fsp.readFile(record, 'utf8')));
  const source = await hashTree(dir);
  if (source.fileCount !== acquisition.files || source.totalBytes !== acquisition.bytes) {
    throw new Error(
      `${dir} holds ${source.fileCount} file(s), ${source.totalBytes} bytes, but the pull copied ` +
        `${acquisition.files} file(s), ${acquisition.bytes} bytes; the folder changed after the pull`
    );
  }

  const previous = readCrashReportsMarker(opts.destDir);
  if (
    !opts.force &&
    previous?.content_root === opts.contentRoot &&
    previous.params.reports_root === source.contentRoot
  ) {
    return { status: 'reused', files: source.fileCount, reportsRoot: source.contentRoot };
  }

  // Marker first, then the directory: no marker ever vouches for a copy being replaced.
  await fsp.rm(path.join(opts.destDir, CRASH_REPORTS_MARKER), { force: true });
  await fsp.rm(opts.destDir, { recursive: true, force: true });
  await fsp.cp(dir, opts.destDir, { recursive: true, preserveTimestamps: true, errorOnExist: true });
  const copied = await hashTree(opts.destDir);
  if (copied.contentRoot !== source.contentRoot) {
    throw new Error(`the copy in ${opts.destDir} doesn't match ${dir}; it gets no marker`);
  }
  await writeFileAtomic(
    path.join(opts.destDir, CRASH_REPORTS_MARKER),
    renderCrashReportsMarker(opts.contentRoot, acquisition.tool, {
      acquired_at: acquisition.acquired_at,
      backup_finished_at: acquisition.backup_finished_at,
      files: acquisition.files,
      bytes: acquisition.bytes,
      reports_root: source.contentRoot,
    })
  );
  return { status: 'copied', files: source.fileCount, reportsRoot: source.contentRoot };
}
