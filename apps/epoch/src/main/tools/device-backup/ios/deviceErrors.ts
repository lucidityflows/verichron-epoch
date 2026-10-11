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

/**
 * Plain-language causes for device error codes Epoch has seen (MBErrorDomain).
 * Add a code only after seeing it from a real device.
 */
const KNOWN_CODES: Record<number, (device: string) => string> = {
  208: (device) => `${device} was locked, so it refused the backup. Unlock it, keep it unlocked, and try again.`,
};

/** A plain-language cause when the reason is a known device error code. */
export function explainFailure(reason: string | undefined, device: string): string | undefined {
  const code = reason?.match(/^ErrorCode (\d+):/)?.[1];
  return code ? KNOWN_CODES[Number(code)]?.(device) : undefined;
}

/** The message for a failed step: the cause when known, and always the tool's own line. */
export function failureMessage(summary: string, lines: string[], device: string, exitCode: number | null): string {
  const reason = failureReason(lines);
  const toolLine = reason ? `idevicebackup2: ${reason}` : `idevicebackup2 exited with code ${exitCode}.`;
  return `${explainFailure(reason, device) ?? summary} ${toolLine}`;
}
