/**
 * Zod mirror of evidence-sidecar.schema.json (package root).
 *
 * Keep the two in step: the field-name parity test in
 * apps/processor/src/utils/manifest.test.ts compares this object's keys
 * against the JSON Schema's `properties`, and
 * packages/contracts/python/test_contract_sync.py validates the example
 * sidecar against the JSON Schema itself.
 */

import { z } from 'zod';

export const EvidenceSidecar = z
  .object({
    schema_version: z.literal(1),
    evidence_name: z.string().min(1),
    algorithm: z.literal('sha256'),
    content_root: z.string().regex(/^[0-9a-f]{64}$/),
    manifest_path: z.string().min(1),
    file_count: z.int().nonnegative(),
    total_bytes: z.int().nonnegative(),
    source_path: z.string().min(1),
    hashed_at: z.iso.datetime({ offset: true }),
    tool: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
  })
  .strict();

export type EvidenceSidecar = z.infer<typeof EvidenceSidecar>;
