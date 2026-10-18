import { z } from 'zod';

import { PrepareStep } from './pipelineEvent.js';

/**
 * The processor's machine-readable result of one Prepare (`summary.json`),
 * read by the app to show each backup's state and, for one that failed, the
 * step and the reason (EPOCH-570). The reason is sanitized before it is
 * written (docs/event-log.md §6.4).
 */
export const ProcessorSummary = z
  .object({
    backups: z.array(
      z
        .object({
          label: z.string().min(1),
          success: z.boolean(),
          /** A decrypt marker vouches for this backup's decrypt. */
          decrypted: z.boolean(),
          failed_step: PrepareStep.nullable(),
          reason: z.string().min(1).nullable(),
        })
        .strict()
        .refine((b) => b.success === (b.failed_step === null && b.reason === null), {
          message: 'a failed backup names its step and reason, and a prepared one names neither',
          path: ['failed_step'],
        })
    ),
  })
  .strict();
export type ProcessorSummary = z.infer<typeof ProcessorSummary>;
