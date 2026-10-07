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
 *     simplest construction that works: a third party can check the root
 *     against the manifest with plain `sha256sum`, with no knowledge of this
 *     tool. A Merkle root could be added later as an extra sidecar field built
 *     from the same per-file hashes, without changing this identity.
 *
 * Manifest line format, one per regular file: `<sha256 hex>  <path>\n`, the
 * same shape `sha256sum` prints. Paths in it are the *canonical* names, which
 * are not always the on-disk names: a file stored under an NFD name (macOS,
 * or a Linux copy of one) is listed under its NFC spelling. So `sha256sum -c`
 * works directly only when every on-disk name is already NFC; verifyManifest()
 * below checks a tree against a manifest by mapping canonical names back to
 * the files that actually exist, and works in every case.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { walkFiles, writeFileAtomic } from "./fs.js";

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

const SHA256_RE = /^[0-9a-f]{64}$/;
const DIGITS_RE = /^\d+$/;

function isFingerprint(value: unknown): value is Fingerprint {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sha256 === "string" && SHA256_RE.test(v.sha256) &&
    typeof v.size === "string" && DIGITS_RE.test(v.size) &&
    // mtime can be negative: files dated before 1970 are valid evidence.
    typeof v.mtimeNs === "string" && /^-?\d+$/.test(v.mtimeNs) &&
    typeof v.ino === "string" && DIGITS_RE.test(v.ino)
  );
}

/**
 * Cached fingerprints keyed by canonical path. A Map, not an object: file
 * names are untrusted keys, and on a plain object `__proto__` would set the
 * prototype and `toString` would find Object.prototype's. Entries that don't
 * look exactly like a fingerprint are dropped, so a stale or hand-edited
 * cache costs a re-hash of those files and can never inject a bad checksum.
 */
async function readCache(cachePath: string): Promise<Map<string, Fingerprint>> {
  const cache = new Map<string, Fingerprint>();
  try {
    const parsed = JSON.parse(await fsp.readFile(cachePath, "utf8"));
    if (parsed?.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) return cache;
    for (const [rel, fp] of Object.entries(parsed.entries)) {
      if (isFingerprint(fp)) cache.set(rel, fp);
    }
  } catch {
    // Missing or unreadable cache only costs a full re-hash; never fatal.
  }
  return cache;
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
  const cache = opts.cachePath && !opts.verify ? await readCache(opts.cachePath) : new Map<string, Fingerprint>();
  const nextCache = new Map<string, Fingerprint>();
  const entries: ManifestEntry[] = [];
  let hashed = 0;
  let reused = 0;
  let totalBytes = 0;

  for await (const absolute of walkFiles(root)) {
    const rel = canonicalPath(path.relative(root, absolute));
    const st = await fsp.stat(absolute, { bigint: true });
    const fp = { size: st.size.toString(), mtimeNs: st.mtimeNs.toString(), ino: st.ino.toString() };

    const cached = cache.get(rel);
    let sha256: string;
    if (cached && cached.size === fp.size && cached.mtimeNs === fp.mtimeNs && cached.ino === fp.ino) {
      sha256 = cached.sha256;
      reused++;
    } else {
      sha256 = await sha256File(absolute);
      hashed++;
    }

    nextCache.set(rel, { ...fp, sha256 });
    entries.push({ path: rel, sha256, size: Number(st.size) });
    totalBytes += Number(st.size);
  }

  const manifest = renderManifest(entries);

  if (opts.cachePath) {
    // Object.fromEntries defines own properties, so a `__proto__` key is
    // serialized as data rather than setting a prototype.
    const serialized = { version: 1, entries: Object.fromEntries(nextCache) };
    await writeFileAtomic(opts.cachePath, JSON.stringify(serialized) + "\n");
  }

  return { manifest, contentRoot: contentRoot(manifest), fileCount: entries.length, totalBytes, hashed, reused };
}

// ---------------------------------------------------------------------------
// Verification against a manifest
// ---------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean;
  /** Canonical paths listed in the manifest with no matching file on disk. */
  missing: string[];
  /** Canonical paths on disk that the manifest doesn't list. */
  extra: string[];
  /** Canonical paths whose content hash differs from the manifest's. */
  mismatched: string[];
}

/**
 * Re-hash `root` and compare it with `manifest`, matching each manifest line
 * to the on-disk file whose canonical name it is. This is the check to use
 * instead of `sha256sum -c`, which fails on files stored under non-NFC names.
 * Always reads every byte; it never consults the stat cache.
 */
export async function verifyManifest(root: string, manifest: string): Promise<VerifyResult> {
  const expected = new Map<string, string>();
  for (const line of manifest.split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`malformed manifest line: ${JSON.stringify(line)}`);
    expected.set(match[2], match[1]);
  }

  const missing: string[] = [];
  const extra: string[] = [];
  const mismatched: string[] = [];
  const seen = new Set<string>();

  for await (const absolute of walkFiles(root)) {
    const rel = canonicalPath(path.relative(root, absolute));
    if (seen.has(rel)) {
      // Same rule as renderManifest: a second on-disk spelling of a listed
      // name must not hide behind the first and pass verification.
      throw new Error(`two files normalize to the same canonical path: ${rel}`);
    }
    seen.add(rel);
    const want = expected.get(rel);
    if (want === undefined) {
      extra.push(rel);
    } else if ((await sha256File(absolute)) !== want) {
      mismatched.push(rel);
    }
  }
  for (const rel of expected.keys()) {
    if (!seen.has(rel)) missing.push(rel);
  }

  const sort = (list: string[]) => list.sort(comparePaths);
  return {
    ok: missing.length + extra.length + mismatched.length === 0,
    missing: sort(missing),
    extra: sort(extra),
    mismatched: sort(mismatched),
  };
}
