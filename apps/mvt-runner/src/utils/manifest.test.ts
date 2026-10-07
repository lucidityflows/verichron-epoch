/**
 * EPOCH-401 definition of done, as tests. Run: pnpm --filter @verichron/mvt-runner test
 *
 * macOS is covered by simulation, not a macOS runner (decided 2026-10-07):
 * the platform differences that matter -- NFD-decomposed names and `\`
 * separators -- are fed in directly, both through the pure functions and as
 * real NFD filenames on disk (Linux stores the bytes as given).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { deriveEvidencePath, EvidenceSidecar } from "@verichron/contracts";

import { writeFileAtomic } from "./fs.js";
import {
  canonicalPath,
  contentRoot,
  hashTree,
  renderManifest,
  verifyManifest,
  type ManifestEntry,
} from "./manifest.js";

/**
 * Golden vector. Computed independently in Python (hashlib, sort by
 * path.encode("utf-8")), not by this code, so a bug here can't agree with
 * itself. The 😀 / ﬁ pair is deliberate: UTF-16 order (JS default sort) puts
 * 😀 first, UTF-8 byte order puts ﬁ first, so a non-byte-wise sort fails this.
 */
const GOLDEN_FILES: Record<string, Buffer> = {
  "a.txt": Buffer.from("alpha\n"),
  "Z upper.txt": Buffer.from("zed\n"),
  "caf\u00e9.txt": Buffer.from("accent\n"),
  "dir/b.bin": Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  "dir/sub/empty": Buffer.alloc(0),
  "\ufb01.txt": Buffer.from("ligature\n"),
  "\u{1F600}.txt": Buffer.from("emoji\n"),
};
const GOLDEN_MANIFEST = [
  "e4c81d6e661b430d874616bb2f2bbf7d5546cfd34097840a4a077991e80ef0dc  Z upper.txt",
  "b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060  a.txt",
  "8f8df9963c9628741bfeeac7efb739164d0858fd03eb1950f385bb26512cef55  caf\u00e9.txt",
  "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880  dir/b.bin",
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  dir/sub/empty",
  "a144caf94237f69af0b4ba8b08ac33d50dfeb9eb33fe54c75ed03a2b9956ad45  \ufb01.txt",
  "5312b0b582d805303c95d7e2b1bc6fad70e04b3dde5413aae758b68767b06ada  \u{1F600}.txt",
].map((line) => line + "\n").join("");
const GOLDEN_ROOT = "2e6be9112ddc57ae61fea2201190ed45b18c70dced9b3de1b50cb953dff2e32a";

const CONTRACTS_DIR = path.resolve(import.meta.dirname, "../../../../packages/contracts");

async function writeTree(root: string, files: Record<string, Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, ...rel.split("/"));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }
}

let tmp: string;
before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "epoch401-"));
});
after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function freshTree(name: string, files: Record<string, Buffer> = GOLDEN_FILES): Promise<string> {
  const root = path.join(tmp, name);
  await writeTree(root, files);
  return root;
}

describe("golden vector", () => {
  it("fixture tree hashes to the known root and manifest", async () => {
    const result = await hashTree(await freshTree("golden"));
    assert.equal(result.manifest, GOLDEN_MANIFEST);
    assert.equal(result.contentRoot, GOLDEN_ROOT);
    assert.equal(result.fileCount, 7);
    assert.equal(result.totalBytes, 6 + 4 + 7 + 256 + 0 + 9 + 6);
  });

  it("root is sha256 of the manifest bytes (verifiable with sha256sum)", () => {
    assert.equal(contentRoot(GOLDEN_MANIFEST), GOLDEN_ROOT);
  });
});

describe("cross-platform invariance", () => {
  const entries = (): ManifestEntry[] =>
    GOLDEN_MANIFEST.trimEnd()
      .split("\n")
      .map((line) => {
        const [sha256, p] = line.split("  ");
        return { sha256, path: p, size: 0 };
      });

  it("shuffled walk order gives an identical root", () => {
    const shuffled = entries().reverse();
    [shuffled[0], shuffled[3]] = [shuffled[3], shuffled[0]];
    assert.equal(contentRoot(renderManifest(shuffled)), GOLDEN_ROOT);
  });

  it("`\\` separators give an identical root", () => {
    const windows = entries().map((e) => ({ ...e, path: canonicalPath(e.path.split("/").join("\\"), "\\") }));
    assert.equal(contentRoot(renderManifest(windows)), GOLDEN_ROOT);
  });

  it("NFD (macOS-style) names give an identical root", () => {
    const nfd = entries().map((e) => ({ ...e, path: canonicalPath(e.path.normalize("NFD"), "/") }));
    assert.ok(nfd.some((e, i) => entries()[i].path.normalize("NFD") !== entries()[i].path), "fixture has an NFD-sensitive name");
    assert.equal(contentRoot(renderManifest(nfd)), GOLDEN_ROOT);
  });

  it("an NFD filename on disk hashes to the same root as its NFC twin", async () => {
    const result = await hashTree(await freshTree("nfd-on-disk", nfdFiles()));
    assert.equal(result.contentRoot, GOLDEN_ROOT);
  });
});

/** The golden tree with caf\u00e9.txt stored under its NFD (macOS-style) name. */
function nfdFiles(): Record<string, Buffer> {
  const files = { ...GOLDEN_FILES };
  delete files["caf\u00e9.txt"];
  files["cafe\u0301.txt"] = GOLDEN_FILES["caf\u00e9.txt"];
  return files;
}

describe("verifyManifest", () => {
  it("verifies an NFD tree end to end, which sha256sum -c cannot", async () => {
    const root = await freshTree("verify-nfd", nfdFiles());
    const { manifest } = await hashTree(root);
    assert.ok(manifest.includes("  caf\u00e9.txt\n"), "manifest lists the canonical (NFC) name");
    assert.equal(fs.existsSync(path.join(root, "caf\u00e9.txt")), false, "only the NFD name exists on disk");

    assert.deepEqual(await verifyManifest(root, manifest), { ok: true, missing: [], extra: [], mismatched: [] });
  });

  it("reports a changed, a removed, and an added file by canonical name", async () => {
    const root = await freshTree("verify-drift", nfdFiles());
    const { manifest } = await hashTree(root);
    await fsp.writeFile(path.join(root, "cafe\u0301.txt"), "tampered\n");
    await fsp.rm(path.join(root, "a.txt"));
    await fsp.writeFile(path.join(root, "new.txt"), "planted\n");

    assert.deepEqual(await verifyManifest(root, manifest), {
      ok: false,
      missing: ["a.txt"],
      extra: ["new.txt"],
      mismatched: ["caf\u00e9.txt"],
    });
  });

  it("a second on-disk spelling of a listed name fails verification", async () => {
    if (process.platform === "darwin") return; // APFS can't hold both names
    const root = await freshTree("verify-twin");
    const { manifest } = await hashTree(root);
    // Identical bytes under the NFD spelling: same canonical path, same hash.
    await fsp.writeFile(path.join(root, "cafe\u0301.txt"), GOLDEN_FILES["caf\u00e9.txt"]);
    await assert.rejects(verifyManifest(root, manifest), /normalize to the same canonical path/);
  });

  it("rejects a malformed manifest instead of skipping lines", async () => {
    await assert.rejects(verifyManifest(tmp, "not a manifest line\n"), /malformed manifest line/);
  });
});

describe("content sensitivity", () => {
  it("changing one byte of one file changes the root", async () => {
    const root = await freshTree("one-byte");
    const target = path.join(root, "dir", "b.bin");
    const bytes = await fsp.readFile(target);
    bytes[128] ^= 0x01;
    await fsp.writeFile(target, bytes);
    const result = await hashTree(root, { verify: true });
    assert.notEqual(result.contentRoot, GOLDEN_ROOT);
  });

  it("two names that normalize to the same path are refused, not merged", async () => {
    if (process.platform === "darwin") return; // APFS can't hold both names
    const root = await freshTree("collision", {
      "caf\u00e9.txt": Buffer.from("one"),
      "cafe\u0301.txt": Buffer.from("two"),
    });
    await assert.rejects(hashTree(root), /normalize to the same canonical path/);
  });

  it("a path containing a line break is refused", () => {
    assert.throws(() => canonicalPath("evil\nffff  injected", "/"), /line break/);
  });
});

describe("stat-fingerprint cache", () => {
  it("skips unchanged files, re-hashes a touched one, and --verify re-hashes all", async () => {
    const root = await freshTree("cache");
    const cachePath = path.join(tmp, "cache.fingerprints.json");

    const first = await hashTree(root, { cachePath });
    assert.deepEqual([first.hashed, first.reused], [7, 0]);

    const second = await hashTree(root, { cachePath });
    assert.deepEqual([second.hashed, second.reused], [0, 7]);
    assert.equal(second.contentRoot, GOLDEN_ROOT);

    const touched = path.join(root, "a.txt");
    const later = new Date(Date.now() + 60_000);
    await fsp.utimes(touched, later, later);
    const third = await hashTree(root, { cachePath });
    assert.deepEqual([third.hashed, third.reused], [1, 6]);
    assert.equal(third.contentRoot, GOLDEN_ROOT, "a touch without a content change keeps the root");

    const verified = await hashTree(root, { cachePath, verify: true });
    assert.deepEqual([verified.hashed, verified.reused], [7, 0]);
  });

  it("a valid-JSON cache with bad entries re-hashes those entries, never trusts them", async () => {
    const root = await freshTree("bad-entries");
    const cachePath = path.join(tmp, "bad-entries.fingerprints.json");
    await hashTree(root, { cachePath });

    const cache = JSON.parse(await fsp.readFile(cachePath, "utf8"));
    delete cache.entries["a.txt"].sha256; // stats still match the file
    cache.entries["dir/b.bin"].sha256 = "Z".repeat(64);
    cache.entries["Z upper.txt"] = "not an object";
    await fsp.writeFile(cachePath, JSON.stringify(cache));

    const result = await hashTree(root, { cachePath });
    assert.deepEqual([result.hashed, result.reused], [3, 4]);
    assert.equal(result.contentRoot, GOLDEN_ROOT);
    assert.ok(!result.manifest.includes("undefined"));
  });

  it("files named __proto__ and toString are cached like any other", async () => {
    // Built with Object.fromEntries so "__proto__" is a real own key here too.
    const root = await freshTree(
      "proto-names",
      Object.fromEntries([
        ["__proto__", Buffer.from("proto\n")],
        ["toString", Buffer.from("tostring\n")],
        ["dir/constructor", Buffer.from("ctor\n")],
      ])
    );
    const cachePath = path.join(tmp, "proto.fingerprints.json");

    const first = await hashTree(root, { cachePath });
    assert.equal(first.fileCount, 3);
    const second = await hashTree(root, { cachePath });
    assert.deepEqual([second.hashed, second.reused], [0, 3]);
    assert.equal(second.contentRoot, first.contentRoot);
  });

  it("a file dated before 1970 stays cached (negative mtime)", async () => {
    const root = await freshTree("pre-epoch");
    const old = new Date("1960-01-01T00:00:00Z");
    await fsp.utimes(path.join(root, "a.txt"), old, old);
    const cachePath = path.join(tmp, "pre-epoch.fingerprints.json");

    await hashTree(root, { cachePath });
    const cache = JSON.parse(await fsp.readFile(cachePath, "utf8"));
    assert.match(cache.entries["a.txt"].mtimeNs, /^-\d+$/, "fixture really has a negative mtime");

    const second = await hashTree(root, { cachePath });
    assert.deepEqual([second.hashed, second.reused], [0, 7]);
  });

  it("a corrupt cache file costs a re-hash, never a failure", async () => {
    const root = await freshTree("corrupt-cache");
    const cachePath = path.join(tmp, "corrupt.fingerprints.json");
    await fsp.writeFile(cachePath, "{not json");
    const result = await hashTree(root, { cachePath });
    assert.deepEqual([result.hashed, result.contentRoot], [7, GOLDEN_ROOT]);
  });
});

describe("writeFileAtomic", () => {
  it("replaces the file and leaves no temp files behind", async () => {
    const dir = path.join(tmp, "atomic");
    const target = path.join(dir, "sidecar.json");
    await writeFileAtomic(target, "old\n");
    await writeFileAtomic(target, "new\n");
    assert.equal(await fsp.readFile(target, "utf8"), "new\n");
    assert.deepEqual(await fsp.readdir(dir), ["sidecar.json"]);
  });

  it("a failed replace leaves the existing file and no temp file", async () => {
    const dir = path.join(tmp, "atomic-fail");
    const existing = path.join(dir, "sidecar.json");
    await writeFileAtomic(existing, "valid\n");
    // A non-empty directory at the target makes rename() fail after the temp
    // file is fully written -- the window between write and publish.
    const blocked = path.join(dir, "blocked");
    await fsp.mkdir(path.join(blocked, "x"), { recursive: true });
    await assert.rejects(writeFileAtomic(blocked, "partial\n"));
    assert.equal(await fsp.readFile(existing, "utf8"), "valid\n");
    assert.deepEqual((await fsp.readdir(dir)).sort(), ["blocked", "sidecar.json"]);
  });
});

describe("evidence paths", () => {
  it("a 255-byte label (the filename limit) still gets writable evidence files", async () => {
    const label = "L".repeat(255);
    const paths = deriveEvidencePath(path.join(tmp, "ws"), label);
    const root = "0".repeat(64);
    for (const file of [paths.sidecar, paths.fingerprints, paths.manifestFor(root)]) {
      assert.equal(path.relative(paths.dir, file).includes(label), false, "label is not part of any file name");
      await writeFileAtomic(file, "x\n");
    }
    assert.deepEqual((await fsp.readdir(paths.dir)).sort(), ["fingerprints.json", "manifests", "sidecar.json"]);
  });
});

describe("evidence sidecar contract", () => {
  const jsonSchema = JSON.parse(
    fs.readFileSync(path.join(CONTRACTS_DIR, "evidence-sidecar.schema.json"), "utf8")
  );
  const example = JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, "evidence-sidecar.example.json"), "utf8"));

  it("the shared example validates against the Zod schema", () => {
    EvidenceSidecar.parse(example);
  });

  it("Zod rejects an unknown field, matching additionalProperties: false", () => {
    assert.throws(() => EvidenceSidecar.parse({ ...example, smuggled: true }));
  });

  it("Zod and JSON Schema declare the same fields", () => {
    assert.deepEqual(Object.keys(EvidenceSidecar.shape).sort(), Object.keys(jsonSchema.properties).sort());
    assert.deepEqual(
      Object.keys(EvidenceSidecar.shape.tool.shape).sort(),
      Object.keys(jsonSchema.properties.tool.properties).sort()
    );
    assert.deepEqual([...jsonSchema.required].sort(), Object.keys(jsonSchema.properties).sort());
  });
});
