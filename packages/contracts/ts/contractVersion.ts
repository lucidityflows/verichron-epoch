import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { layout } from './layout.js';

/**
 * The contract version every run records (R35): sha256 over the canonical
 * schema files, so "why did this differ from last month?" can be answered by
 * comparing two runs' contract versions.
 *
 * Each file contributes `<name>\n<bytes>\n` in name order, so adding, removing
 * or renaming a schema changes the version as well as editing one.
 */
export const CONTRACT_SCHEMAS = [
  'evidence-sidecar.schema.json',
  'normalized-record.schema.json',
  'stage-manifest.schema.json',
  'workspace-manifest.schema.json',
] as const;

/** The contracts package root: under the layout's source, in a checkout and in
 * the Lab bundle alike (layout.ts). */
export function packageRoot(): string {
  return path.join(layout().source, 'packages', 'contracts');
}

export function contractVersion(): string {
  const root = packageRoot();
  const hash = createHash('sha256');
  for (const name of [...CONTRACT_SCHEMAS].sort()) {
    hash.update(`${name}\n`);
    hash.update(readFileSync(path.join(root, name)));
    hash.update('\n');
  }
  return hash.digest('hex');
}
