import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { ToolAvailabilityStatus } from '../../../shared/types/tools';

/**
 * Looks for `binaryName` in two places, in order:
 *
 *   1. A bundled resources path, if the caller has one (e.g. a binary
 *      VeriChron ships with a release, or one dropped in place by a prior
 *      "download verified release" or "compile from source" run).
 *   2. The system PATH, via the platform's own lookup command (`where` on
 *      Windows, `command -v` elsewhere) -- so a self-compiled install
 *      (`make install`) or a system package (`apt install
 *      libimobiledevice-utils`) is found the same way regardless of how it
 *      got there.
 *
 * Returns a real, absolute path on success -- never just "yes it exists
 * somewhere" -- so a caller can spawn it directly without re-resolving.
 */
export function detectBinary(binaryName: string, bundledPath?: string): ToolAvailabilityStatus {
  if (bundledPath) {
    try {
      if (fs.statSync(bundledPath).isFile()) {
        return { available: true, path: bundledPath };
      }
    } catch {
      // Stat error means the file is unavailable; fallback to PATH lookup
    }
  }

  try {
    const lookupCmd = process.platform === 'win32' ? 'where' : 'command';
    const lookupArgs = process.platform === 'win32' ? [binaryName] : ['-v', binaryName];
    // 'command -v' is a shell builtin on POSIX, not a real executable --
    // needs a shell to resolve. 'where' on Windows is a real executable.
    const result =
      process.platform === 'win32'
        ? execFileSync(lookupCmd, lookupArgs, { encoding: 'utf-8' })
        : execFileSync('/bin/sh', ['-c', `command -v ${binaryName}`], { encoding: 'utf-8' });
    const resolved = result.trim().split('\n')[0];
    if (resolved) {
      return { available: true, path: resolved };
    }
  } catch {
    // Non-zero exit from `where`/`command -v` means "not found" -- not an
    // error worth surfacing, just the negative case.
  }

  return {
    available: false,
    reason: bundledPath ? `Not found at the expected bundled path (${bundledPath}) or on PATH.` : 'Not found on PATH.',
  };
}

/** Standard bundled-resources location for a given tool, following
 * Electron's own convention of platform+arch-scoped resource subfolders --
 * keeps a Windows binary, a macOS binary, and a Linux binary from ever
 * colliding in the same install. */
export function bundledToolPath(resourcesPath: string, toolName: string): string {
  const isWindows = process.platform === 'win32';
  const executableName = isWindows ? `${toolName}.exe` : toolName;
  return path.join(resourcesPath, 'bin', executableName);
}
