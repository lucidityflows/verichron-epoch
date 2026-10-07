/**
 * Canonical evidence manifest and content root (EPOCH-401).
 *
 * The content root is the evidence identity: EPOCH-402 keys `evidence_items`
 * on it, so the same backup must produce the same root on every machine, and
 * any byte change must produce a different one. Everything here exists to make
 * that true across platforms:
 *
 *   - Paths are relative to the backup root, NFC-normalized (macOS hands back
 *     NFD-decomposed names from some filesystems; Linux returns whatever bytes
 *     were written), and always `/`-separated regardless of OS.
 *   - Lines are sorted by the UTF-8 bytes of the path, not by locale or by
 *     JS string order (UTF-16 code units), so walk order and collation can't
 *     leak into the result.
 *   - The root is sha256 of the exact manifest bytes. That is deliberately the
 *     simplest construction that works: a third party can verify it with
 *     `sha256sum` and the manifest file, with no knowledge of this tool. A
 *     Merkle root could be added later as an extra sidecar field built from
 *     the same per-file hashes, without changing this identity.
 *
 * Manifest line format, one per regular file: `<sha256 hex>  <path>\n`
 * (two spaces, matching `sha256sum` output so `sha256sum -c` can check it).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { walkFiles } from "./fs.js";

export interface ManifestEntry {
  /** Canonical relative path: NFC, `/`-separated. */
  path: string;
  sha256: string;
  size: number;
}

/** Relative path -> canonical form. `sep` is the separator the input uses. */
export function canonicalPath(relative: string, sep: string = path.sep): string {
  const slashed = sep === "/" ? relative : relative.split(sep).join("/");
  const canonical = slashed.normalize("NFC");
  if (canonical.includes("\n") || canonical.includes("\r")) {
    // A newline would forge an extra manifest line. Refuse rather than
    // escape: no real backup path contains one, and escaping would make the
    // manifest diverge from sha256sum's format.
    throw new Error(`refusing to hash path containing a line break: ${JSON.stringify(canonical)}`);
  }
  return canonical;
}

/** Byte-wise comparison of the UTF-8 encoding of two canonical paths. */
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Canonical manifest text for a set of entries, in any input order. */
export function renderManifest(entries: Iterable<ManifestEntry>): string {
  const sorted = [...entries].sort((x, y) => comparePaths(x.path, y.path));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].path === sorted[i - 1].path) {
      // Two distinct on-disk names that normalize to the same NFC path. Both
      // can exist on Linux; silently keeping one would drop evidence.
      throw new Error(`two files normalize to the same canonical path: ${sorted[i].path}`);
    }
  }
  return sorted.map((e) => `${e.sha256}  ${e.path}\n`).join("");
}

export function contentRoot(manifest: string): string {
  return crypto.createHash("sha256").update(manifest, "utf8").digest("hex");
}

export function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(p);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Stat-fingerprint cache
// ---------------------------------------------------------------------------

interface Fingerprint {
  size: string;
  mtimeNs: string;
  ino: string;
  sha256: string;
}

interface FingerprintCache {
  version: 1;
  entries: Record<string, Fingerprint>;
}

async function readCache(cachePath: string): Promise<FingerprintCache["entries"]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(cachePath, "utf8")) as FingerprintCache;
    return parsed.version === 1 && parsed.entries ? parsed.entries : {};
  } catch {
    // Missing or unreadable cache only costs a full re-hash; never fatal.
    return {};
  }
}

export interface HashTreeOptions {
  /** Where to read/write the stat-fingerprint cache. Omit to disable caching. */
  cachePath?: string;
  /** Ignore the cache and re-hash every file (the cache is still rewritten). */
  verify?: boolean;
}

export interface HashTreeResult {
  manifest: string;
  contentRoot: string;
  fileCount: number;
  totalBytes: number;
  /** Files actually read and hashed this run. */
  hashed: number;
  /** Files whose hash was reused from the cache. */
  reused: number;
}

/**
 * Hash every regular file under `root` into a canonical manifest.
 *
 * A cached hash is reused only when size, mtime (nanoseconds) and inode all
 * match. That catches edits, touches and replace-by-rename; it is a speed-up
 * for unchanged trees, not a substitute for --verify, which always re-reads.
 */
export async function hashTree(root: string, opts: HashTreeOptions = {}): Promise<HashTreeResult> {
  const cache = opts.cachePath && !opts.verify ? await readCache(opts.cachePath) : {};
  const nextCache: FingerprintCache = { version: 1, entries: {} };
  const entries: ManifestEntry[] = [];
  let hashed = 0;
  let reused = 0;
  let totalBytes = 0;

  for await (const absolute of walkFiles(root)) {
    const rel = canonicalPath(path.relative(root, absolute));
    const st = await fsp.stat(absolute, { bigint: true });
    const fp = { size: st.size.toString(), mtimeNs: st.mtimeNs.toString(), ino: st.ino.toString() };

    const cached = cache[rel];
    let sha256: string;
    if (cached && cached.size === fp.size && cached.mtimeNs === fp.mtimeNs && cached.ino === fp.ino) {
      sha256 = cached.sha256;
      reused++;
    } else {
      sha256 = await sha256File(absolute);
      hashed++;
    }

    nextCache.entries[rel] = { ...fp, sha256 };
    entries.push({ path: rel, sha256, size: Number(st.size) });
    totalBytes += Number(st.size);
  }

  const manifest = renderManifest(entries);

  if (opts.cachePath) {
    await fsp.mkdir(path.dirname(opts.cachePath), { recursive: true });
    await fsp.writeFile(opts.cachePath, JSON.stringify(nextCache) + "\n");
  }

  return { manifest, contentRoot: contentRoot(manifest), fileCount: entries.length, totalBytes, hashed, reused };
}
