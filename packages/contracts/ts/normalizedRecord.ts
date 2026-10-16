/**
 * Zod mirror of normalized-record.schema.json -- the record SHAPE only.
 *
 * SourceType is NOT defined here. It's owned by sourceType.ts (see that
 * file's own docstring). Re-exported so `import { SourceType } from
 * '@verichron/contracts'` keeps working unchanged for every existing caller.
 */

import { z } from 'zod';
export { SourceType } from './sourceType';
import { SourceType } from './sourceType';

const SourceTypeSchema = z.nativeEnum(SourceType);

export const NormalizedRecord = z
  .object({
    incident_id: z.string().nullable().optional().default(null),
    source_type: SourceTypeSchema,
    event_time: z.string().datetime().nullable().optional().default(null),
    bug_type: z.string().nullable().optional().default(null),
    process_name: z.string().nullable().optional().default(null),
    pid: z.number().int().nullable().optional().default(null),
    bundle_id: z.string().nullable().optional().default(null),
    fields: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type NormalizedRecord = z.infer<typeof NormalizedRecord>;
