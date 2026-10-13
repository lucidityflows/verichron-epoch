import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

/**
 * Completion markers the processor writes when a derivative is finished, and
 * the orchestrator reads before registering it (EPOCH-404, EPOCH-406).
 *
 * Each marker records the content_root of the evidence the derivative was
 * produced FROM. Without it, a backup that changed under the same label would
 * be re-hashed (new content_root) while its old decrypt and iLEAPP output stayed in
 * place behind their "done" markers, and registration would file the old
 * backup's facts under the new evidence. With it, a stale derivative is
 * detectable: the processor redoes it, and registration refuses it.
 *
 * Each marker also carries the derivative's provenance (EPOCH-406): the tool
 * that produced it and the parameters that shaped it. Registration copies
 * these into evidence_derivatives.tool / .params, and they are part of the
 * derivative's identity (provenanceKey), so a different tool version, repair
 * outcome or input type is a different derivative, never an update in place.
 */
export const DECRYPT_MARKER = '.decrypted_ok';
export const ILEAPP_MARKER = '.ileapp_ok';

/** The derivative kinds evidence_derivatives.kind allows (migration 0009). */
export const DerivativeKind = z.enum(['decrypted', 'ileapp_output']);
export type DerivativeKind = z.infer<typeof DerivativeKind>;

const ContentRoot = z.string().regex(/^[0-9a-f]{64}$/);
const Count = z.number().int().nonnegative();

export const ToolVersion = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();
export type ToolVersion = z.infer<typeof ToolVersion>;

/**
 * What the SQLite repair pass did to a decrypt. Paths are relative to the
 * decrypted directory. `skipped` is recorded rather than omitted, so "no
 * repair was attempted" can't be mistaken for "nothing needed repair".
 */
export const RepairProvenance = z.discriminatedUnion('status', [
  z.object({ status: z.literal('skipped'), reason: z.string().min(1) }).strict(),
  z
    .object({
      status: z.literal('ran'),
      tool: ToolVersion,
      scanned: Count,
      repaired: Count,
      /** Databases still failing quick_check after recovery. */
      failed_files: z.array(z.string()),
      /** The originals kept as `<db>.corrupt-<timestamp>` before each recovery. */
      preserved_originals: z.array(z.string()),
    })
    .strict(),
]);
export type RepairProvenance = z.infer<typeof RepairProvenance>;

export const DecryptParams = z.object({ repair: RepairProvenance }).strict();
export type DecryptParams = z.infer<typeof DecryptParams>;

export const IleappParams = z
  .object({
    /** How iLEAPP walked the decrypt (its -t): 'itunes' with a Manifest.db, else 'fs'. */
    input_type: z.enum(['itunes', 'fs']),
  })
  .strict();
export type IleappParams = z.infer<typeof IleappParams>;

const markerOf = <P extends z.ZodTypeAny>(params: P) =>
  z
    .object({
      content_root: ContentRoot,
      completed_at: z.iso.datetime({ offset: true }),
      tool: ToolVersion,
      params,
    })
    .strict();

export const DecryptMarker = markerOf(DecryptParams);
export type DecryptMarker = z.infer<typeof DecryptMarker>;
export const IleappMarker = markerOf(IleappParams);
export type IleappMarker = z.infer<typeof IleappMarker>;

function readMarker<S extends z.ZodTypeAny>(schema: S, dir: string, marker: string): z.infer<S> | null {
  const file = path.join(dir, marker);
  if (!existsSync(file)) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The decrypt's provenance, or null if the marker is missing or not in this format. */
export const readDecryptMarker = (dir: string): DecryptMarker | null => readMarker(DecryptMarker, dir, DECRYPT_MARKER);

/** iLEAPP's output's provenance, or null if the marker is missing or not in this format. */
export const readIleappMarker = (dir: string): IleappMarker | null => readMarker(IleappMarker, dir, ILEAPP_MARKER);

export function renderDecryptMarker(contentRoot: string, tool: ToolVersion, params: DecryptParams): string {
  return render(DecryptMarker, contentRoot, tool, params);
}

export function renderIleappMarker(contentRoot: string, tool: ToolVersion, params: IleappParams): string {
  return render(IleappMarker, contentRoot, tool, params);
}

function render<S extends z.ZodTypeAny>(schema: S, contentRoot: string, tool: ToolVersion, params: unknown): string {
  const marker = { content_root: contentRoot, completed_at: new Date().toISOString(), tool, params };
  return JSON.stringify(schema.parse(marker)) + '\n';
}

/** JSON with object keys sorted at every level, so equal values serialize identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Part of a derivative's identity: sha256 over the canonical JSON of
 * {tool, params}. Two passes that differ in tool version, repair outcome or
 * input type get different keys, so they are different derivatives.
 */
export function provenanceKey(tool: ToolVersion, params: unknown): string {
  return createHash('sha256').update(canonicalJson({ tool, params })).digest('hex');
}
