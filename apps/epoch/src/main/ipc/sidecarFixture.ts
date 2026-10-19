import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * A backup's evidence sidecar as Prepare writes it before it decrypts
 * (EPOCH-401), for tests whose workspaces hold a decrypt: readPreparedBackups
 * refuses a decrypt without one.
 */
export function writeSidecarFixture(sidecarPath: string, label: string, contentRoot: string, fileCount = 9870): void {
  mkdirSync(path.dirname(sidecarPath), { recursive: true });
  writeFileSync(
    sidecarPath,
    JSON.stringify({
      schema_version: 1,
      evidence_name: label,
      algorithm: 'sha256',
      content_root: contentRoot,
      // Not read by the tests that use this; the workspace layout itself is never built in code.
      manifest_path: `${contentRoot}.sha256`,
      file_count: fileCount,
      total_bytes: 58_400_000_000,
      source_path: `/source/${label}`,
      hashed_at: '2026-10-15T15:20:00Z',
      tool: { name: 'processor', version: '0.1.0' },
    })
  );
}
