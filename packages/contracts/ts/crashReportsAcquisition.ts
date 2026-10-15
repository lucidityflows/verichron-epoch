import * as path from 'node:path';
import { z } from 'zod';

/**
 * Where an iPhone pull leaves the device's crash logs (EPOCH-514): beside the
 * backup, never inside it, so the backup's content identity (R6) is the
 * device's backup alone.
 *
 *   <pull folder>/<UDID>/                       the backup
 *   <pull folder>/<UDID>.crash-reports/         the crash logs, as idevicecrashreport -k copied them
 *   <pull folder>/<UDID>.crash-reports.json     how they were copied (CrashReportsAcquisition)
 *
 * The record is written only once the copy finished, so a folder without one
 * is an unfinished copy and is not used. Neither path holds a Manifest.db or
 * Info.plist, so backup discovery never takes them for a backup.
 */
export function crashReportsAcquisitionPaths(backupDir: string): { dir: string; record: string } {
  const resolved = path.resolve(backupDir);
  return { dir: `${resolved}.crash-reports`, record: `${resolved}.crash-reports.json` };
}

/** How a pull copied the crash logs. The device's identifier is not recorded here; the pull record has it. */
export const CrashReportsAcquisition = z
  .object({
    tool: z.object({ name: z.literal('idevicecrashreport'), version: z.string().min(1) }).strict(),
    /** Copied with -k: the reports were left on the device. Nothing else is accepted. */
    kept_on_device: z.literal(true),
    acquired_at: z.iso.datetime({ offset: true }),
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export type CrashReportsAcquisition = z.infer<typeof CrashReportsAcquisition>;
