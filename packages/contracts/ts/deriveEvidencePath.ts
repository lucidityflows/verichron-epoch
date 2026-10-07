import * as path from 'node:path';

/**
 * Where mvt-runner writes, and the orchestrator reads, a backup's evidence
 * artifacts inside a workspace. One helper so the two never disagree about
 * the layout -- the same reason deriveResultsPath exists.
 */
export function deriveEvidencePath(workspace: string, evidenceName: string) {
  return {
    /** Sidecar JSON (validates against evidence-sidecar.schema.json). */
    sidecar: path.join(workspace, 'evidence', `${evidenceName}.evidence.json`),
    /** Canonical manifest; content_root is sha256 of this file's bytes. */
    manifest: path.join(workspace, 'hashes', `${evidenceName}.sha256`),
    /** Stat-fingerprint cache; safe to delete, costs one full re-hash. */
    fingerprints: path.join(workspace, 'hashes', `${evidenceName}.fingerprints.json`),
  };
}
