import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Where everything the app runs lives (EPOCH-478; docs/architecture.md, "The
 * Lab bundle"). Two layouts share one rule, so no other code knows either:
 *
 * - **checkout**: a repository checkout, as in development and CI. The root
 *   holds `pnpm-workspace.yaml` and `packages/contracts/`.
 * - **bundle**: the Lab bundle. The root holds `MANIFEST`, `source/` (the
 *   repository's Python side, laid out as in a checkout) and `runtime-venv/`.
 *
 * The root is found by walking up from where the running code sits, so it
 * holds wherever the bundle is unpacked: the compiled services in `services/`,
 * the packaged app under `app/`, or a checkout's sources, `dist/` or Vite build.
 */
export interface Layout {
  kind: 'checkout' | 'bundle';
  root: string;
  /** The repository's layout: the checkout itself, or the bundle's `source/`. */
  source: string;
  /** The interpreter the stages run with. */
  python: string;
  /** The Python version the interpreter must be (`.python-version`). */
  pythonVersionFile: string;
  decryptPython: string;
  decryptScript: string;
  ileappDir: string;
  ileappPython: string;
  /** iLEAPP's commit as the build recorded it; null in a checkout, where git says it. */
  ileappCommitFile: string | null;
}

/** The layout whose root holds `dir`, or null when `dir` is no root. */
export function layoutAt(dir: string): Layout | null {
  if (
    existsSync(path.join(dir, 'MANIFEST')) &&
    existsSync(path.join(dir, 'source')) &&
    existsSync(path.join(dir, 'runtime-venv'))
  ) {
    return {
      kind: 'bundle',
      root: dir,
      source: path.join(dir, 'source'),
      python: path.join(dir, 'runtime-venv', 'bin', 'python'),
      pythonVersionFile: path.join(dir, 'source', '.python-version'),
      ...tools(dir),
      ileappCommitFile: path.join(dir, 'tools', 'ileapp', 'iLEAPP.commit'),
    };
  }
  if (existsSync(path.join(dir, 'pnpm-workspace.yaml')) && existsSync(path.join(dir, 'packages', 'contracts'))) {
    return {
      kind: 'checkout',
      root: dir,
      source: dir,
      python: path.join(dir, '.venv', 'bin', 'python'),
      pythonVersionFile: path.join(dir, '.python-version'),
      ...tools(dir),
      ileappCommitFile: null,
    };
  }
  return null;
}

/** The tools sit at the same place under either root. */
function tools(root: string) {
  return {
    decryptPython: path.join(root, 'tools', 'decrypt', '.venv', 'bin', 'python'),
    decryptScript: path.join(root, 'tools', 'decrypt', 'decrypt_backup.py'),
    ileappDir: path.join(root, 'tools', 'ileapp', 'iLEAPP'),
    ileappPython: path.join(root, 'tools', 'ileapp', '.venv', 'bin', 'python'),
  };
}

/** The layout above `from`, the nearest root first. Fails when there is none. */
export function findLayout(from: string): Layout {
  let dir = path.resolve(from);
  for (;;) {
    const layout = layoutAt(dir);
    if (layout) return layout;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`no Verichron Epoch checkout or bundle contains ${from}`);
    }
    dir = parent;
  }
}

let current: Layout | undefined;

/**
 * The layout this code runs in. This package compiles to CommonJS, so
 * `__dirname` is the running code's own directory: inlined into a service or
 * the app, it is theirs.
 */
export function layout(): Layout {
  current ??= findLayout(__dirname);
  return current;
}

/** A package's version, read from its package.json under the layout's source. */
export function packageVersion(lay: Layout, packageDir: string): string {
  const manifest = JSON.parse(readFileSync(path.join(lay.source, packageDir, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof manifest.version !== 'string') throw new Error(`${packageDir}/package.json has no version`);
  return manifest.version;
}
