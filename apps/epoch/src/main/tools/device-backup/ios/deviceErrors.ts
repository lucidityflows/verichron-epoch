/**
 * Reading idevicebackup2's failures (EPOCH-466). The tool prints its errors
 * on stdout. A device refusal is an `ErrorCode <n>: <description>` line,
 * followed by a generic summary ("Backup Failed (Error Code n).", "Could not
 * enable backup encryption.") that names no cause.
 */

/** The device's or tool's own reason for a failure, else the last line. */
export function failureReason(lines: string[]): string | undefined {
  return [...lines].reverse().find((line) => /^(ErrorCode \d+:|ERROR:)/.test(line)) ?? lines[lines.length - 1];
}

export interface FailureContext {
  device: string;
  destDir: string;
  /** Free space in destDir when the step failed; null when unknown. */
  freeBytes: number | null;
  /** Whether the device was still connected when the step failed; null when unknown. */
  connected?: boolean | null;
  /** What this pull had written when it failed; null when unknown. */
  receivedBytes?: number | null;
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/**
 * Plain-language causes for device error codes Epoch has seen (MBErrorDomain).
 * Add a code only after seeing it from a real device.
 */
const KNOWN_CODES: Record<number, (ctx: FailureContext) => string> = {
  105: ({ device, destDir, freeBytes }) =>
    `${device} needs more free space on this computer than ${freeBytes === null ? 'is free' : `the ${gb(freeBytes)} free`} in ${destDir}. ` +
    `Free up space or choose a folder on a larger drive.`,
  208: ({ device }) => `${device} was locked, so it refused the backup. Unlock it, keep it unlocked, and try again.`,
};

/**
 * What idevicebackup2 prints when the connection to the device drops
 * mid-backup, as seen on a real device when the cable was pulled (EPOCH-507).
 */
const LOST_CONNECTION = /^ERROR: Could not receive from mobilebackup2 \(-4\)/;

/**
 * A plain-language cause when the reason is a known device error code, or a
 * lost connection confirmed by the device no longer being listed.
 */
export function explainFailure(reason: string | undefined, ctx: FailureContext): string | undefined {
  if (reason && LOST_CONNECTION.test(reason) && ctx.connected === false) {
    const arrived = ctx.receivedBytes ? ` (${gb(ctx.receivedBytes)} had arrived)` : '';
    return (
      `${ctx.device} was disconnected during the backup${arrived}. Reconnect it and start again; ` +
      `the unfinished backup can't be resumed.`
    );
  }
  const code = reason?.match(/^ErrorCode (\d+):/)?.[1];
  return code ? KNOWN_CODES[Number(code)]?.(ctx) : undefined;
}

/** The message for a failed step: the cause when known, and always the tool's own line. */
export function failureMessage(summary: string, lines: string[], exitCode: number | null, ctx: FailureContext): string {
  const reason = failureReason(lines);
  const toolLine = reason ? `idevicebackup2: ${reason}` : `idevicebackup2 exited with code ${exitCode}.`;
  return `${explainFailure(reason, ctx) ?? summary} ${toolLine}`;
}
