import * as path from 'node:path';

/**
 * Where mvt-runner writes, and the orchestrator reads, a backup's evidence
 * artifacts inside a workspace. One helper so the two never disagree about
 * the layout -- the same reason deriveResultsPath exists.
 *
 * Everything lives under one directory per backup, `evidence/<name>/`, with
 * fixed short file names inside. The label is used as a whole path component
 * and nothing is appended to it, so these paths need no more name length
 * than decrypted/<name> and results/<name> already do. (Appending a suffix
 * such as `.<64-hex root>.sha256` to the label could push a long but valid
 * label past a 255-byte filename limit.)
 */
export function deriveEvidencePath(workspace: string, evidenceName: string) {
  const dir = path.join(workspace, 'evidence', evidenceName);
  return {
    dir,
    /** Sidecar JSON (validates against evidence-sidecar.schema.json). */
    sidecar: path.join(dir, 'sidecar.json'),
    /**
     * Canonical manifest for a given root; content_root is sha256 of this
     * file's bytes. Content-addressed so a published manifest is never
     * overwritten: a sidecar naming a root always finds the matching
     * manifest, even if the backup has since changed and been re-hashed.
     */
    manifestFor: (contentRoot: string) => path.join(dir, 'manifests', `${contentRoot}.sha256`),
    /** Stat-fingerprint cache; safe to delete, costs one full re-hash. */
    fingerprints: path.join(dir, 'fingerprints.json'),
  };
}
