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
    /**
     * Canonical manifest for a given root; content_root is sha256 of this
     * file's bytes. Content-addressed so a published manifest is never
     * overwritten: a sidecar naming a root always finds the matching
     * manifest, even if the backup has since changed and been re-hashed.
     */
    manifestFor: (contentRoot: string) =>
      path.join(workspace, 'hashes', `${evidenceName}.${contentRoot}.sha256`),
    /** Stat-fingerprint cache; safe to delete, costs one full re-hash. */
    fingerprints: path.join(workspace, 'hashes', `${evidenceName}.fingerprints.json`),
  };
}
