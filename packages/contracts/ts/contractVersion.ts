import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

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
] as const;

/** The package root, found by walking up from this file: it runs from ts/ under
 * tsx and from dist/ts/ once built, so a fixed relative path would be wrong in
 * one of the two. */
export function packageRoot(): string {
  // This package compiles to CommonJS, so __dirname (not import.meta) is available.
  let dir = __dirname;
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@verichron/contracts') {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('could not locate the @verichron/contracts package root');
    dir = parent;
  }
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
