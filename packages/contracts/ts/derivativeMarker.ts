import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

/**
 * Completion markers mvt-runner writes when a derivative is finished, and
 * the orchestrator reads before registering it (EPOCH-404).
 *
 * Each marker records the content_root of the evidence the derivative was
 * produced FROM. Without it, a backup that changed under the same label would
 * be re-hashed (new content_root) while its old decrypt and results stayed in
 * place behind their "done" markers, and registration would file the old
 * backup's facts under the new evidence. With it, a stale derivative is
 * detectable: mvt-runner redoes it, and registration refuses it.
 */
export const DECRYPT_MARKER = '.mvt_decrypted_ok';
export const CHECK_MARKER = '.mvt_check_ok';

export const DerivativeMarker = z
  .object({
    content_root: z.string().regex(/^[0-9a-f]{64}$/),
    completed_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export type DerivativeMarker = z.infer<typeof DerivativeMarker>;

/** The marker's provenance, or null if it is missing or not in this format. */
export function readDerivativeMarker(dir: string, marker: string): DerivativeMarker | null {
  const file = path.join(dir, marker);
  if (!existsSync(file)) return null;
  try {
    const parsed = DerivativeMarker.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function renderDerivativeMarker(contentRoot: string): string {
  const marker: DerivativeMarker = { content_root: contentRoot, completed_at: new Date().toISOString() };
  return JSON.stringify(DerivativeMarker.parse(marker)) + '\n';
}
