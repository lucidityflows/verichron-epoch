import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Sanitizer,
  deviceIdentifierSources,
  readTaskLog,
  readWorkspaceManifestSync,
  resolveTaskLogsPath,
  resolveWorkspaceBackup,
  type SanitizedClass,
} from '@verichron/contracts';

/**
 * The real-data check of the task log's sanitizer (EPOCH-570,
 * docs/event-log.md §6.5): run locally against a workspace with real
 * evidence, never in CI, and never committed.
 *
 * It reads every saved log and looks for anything left of the values the
 * sanitizer knows: the workspace's backups' identifiers and the workstation's
 * roots. The report holds counts only. The review, every line with a marker
 * and every absolute path left, quotes the logs, so it goes to a file of the
 * examiner's choosing, not to the screen.
 */

export interface SanitizerCheckReport {
  logs: number;
  entries: number;
  /** Lines that are not valid entries, or a cut-off last line. */
  problems: number;
  /** Markers in the saved logs, by kind: what the sanitizer replaced. */
  markers: Record<string, number>;
  /** What is left of a known value: must be empty. */
  residue: Partial<Record<SanitizedClass, number>>;
  /** Distinct absolute paths left, for the review to justify. */
  remainingPaths: number;
  pass: boolean;
}

const MARKER =
  /\[(device|device-guid|serial|imei|meid|iccid|phone|password)\b[^\]]*\]|<(workspace|source|app|temp|user)>|(?<![\w.~])~(?=\/|$)/g;
/** An absolute path that no root marker begins. */
const BARE_PATH = /(?<![\w.~>\]])\/(?:[\w.@+,-]+\/?)+/g;

export async function checkTaskLogs(
  workspace: string,
  appRoot: string
): Promise<{ report: SanitizerCheckReport; review: string }> {
  const manifest = readWorkspaceManifestSync(workspace);
  const backups = manifest.backups.map((entry) => {
    const resolved = resolveWorkspaceBackup(workspace, entry);
    const fromSource = existsSync(path.join(resolved.sourcePath, 'Info.plist'));
    return { label: entry.label, path: fromSource ? resolved.sourcePath : resolved.decryptedPath };
  });
  const sanitizer = Sanitizer.create(deviceIdentifierSources(backups), {
    workspace: path.resolve(workspace),
    app: appRoot,
    temp: os.tmpdir(),
    home: os.homedir(),
    user: os.userInfo().username,
  });

  const dir = resolveTaskLogsPath(workspace, manifest);
  const files = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith('.ndjson')).sort() : [];
  const report: SanitizerCheckReport = {
    logs: files.length,
    entries: 0,
    problems: 0,
    markers: {},
    residue: {},
    remainingPaths: 0,
    pass: false,
  };
  const marked: string[] = [];
  const paths = new Map<string, number>();

  for (const file of files) {
    const text = await readFile(path.join(dir, file), 'utf8');
    const read = readTaskLog(text);
    report.entries += read.entries.length;
    report.problems += read.invalid.length + (read.truncated ? 1 : 0);
    // The whole file, not only messages: an event's fields are saved too.
    for (const [cls, n] of Object.entries(sanitizer.residue(text))) {
      report.residue[cls as SanitizedClass] = (report.residue[cls as SanitizedClass] ?? 0) + n;
    }
    text.split('\n').forEach((line, i) => {
      const found = line.match(MARKER) ?? [];
      for (const m of found) {
        const kind = m.startsWith('[') ? m.slice(1).split(/[\s\]]/)[0] : m.startsWith('<') ? m : '~';
        report.markers[kind] = (report.markers[kind] ?? 0) + 1;
      }
      if (found.length > 0) {
        const entry = read.entries.find((e) => e.seq === i + 1);
        marked.push(`${file}:${i + 1}  ${entry ? entry.message : line}`);
      }
      for (const p of line.match(BARE_PATH) ?? []) {
        const group = p.split('/').slice(0, 3).join('/');
        paths.set(group, (paths.get(group) ?? 0) + 1);
      }
    });
  }
  report.remainingPaths = paths.size;
  report.pass = report.logs > 0 && report.problems === 0 && Object.keys(report.residue).length === 0;

  const review = [
    `# Task log sanitizer review: ${new Date().toISOString()}`,
    '',
    `Logs ${report.logs}, entries ${report.entries}, problems ${report.problems}.`,
    `Residue: ${Object.keys(report.residue).length === 0 ? 'none' : JSON.stringify(report.residue)}.`,
    '',
    '## Lines with a marker (check each is a true replacement)',
    '',
    ...(marked.length > 0 ? marked : ['(none)']),
    '',
    '## Absolute paths left, by their first segments (justify or remove each at its source)',
    '',
    ...([...paths].sort((a, b) => b[1] - a[1]).map(([group, n]) => `${String(n).padStart(6)}  ${group}`) || []),
    ...(paths.size === 0 ? ['(none)'] : []),
    '',
  ].join('\n');
  return { report, review };
}
