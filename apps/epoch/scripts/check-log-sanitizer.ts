/**
 * The real-data check of the task log's sanitizer (EPOCH-570,
 * docs/event-log.md §6.5). Run it locally against a workspace with real
 * evidence; it never runs in CI.
 *
 *   pnpm --filter @verichron/epoch check:log-sanitizer <workspace> --out <review file>
 *
 * It prints counts only. The review quotes the logs, so it is written to the
 * file given (mode 0600), never to the screen. It exits 1 unless every log
 * reads and nothing is left of a known value.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { checkTaskLogs } from '../src/main/ipc/sanitizerCheck';

const { values, positionals } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: true });
const [workspace] = positionals;
if (!workspace || !values.out) {
  console.error('usage: check:log-sanitizer <workspace> --out <review file>');
  process.exit(2);
}

// apps/epoch/scripts/ is two levels below the repository, the app's root in development.
const appRoot = path.resolve(__dirname, '..', '..', '..');
const out = values.out;

void checkTaskLogs(path.resolve(workspace), appRoot).then(({ report, review }) => {
  writeFileSync(out, review, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  console.log(report.pass ? 'PASS' : 'FAIL');
  process.exit(report.pass ? 0 : 1);
});
