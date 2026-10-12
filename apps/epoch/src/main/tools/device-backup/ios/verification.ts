import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface BackupVerificationResult {
  isValid: boolean;
  missingArtifacts: string[];
  corruptedFiles: string[];
}

/**
 * Verifies backup artifacts, documenting and recording missing or corrupted state
 * rather than hard-failing, allowing partial analysis of available files.
 */
export async function verifyBackupArtifacts(backupPath: string): Promise<BackupVerificationResult> {
  const essentialArtifacts = ['Manifest.plist', 'Manifest.db', 'Info.plist', 'Status.plist'];
  const missingArtifacts: string[] = [];
  const corruptedFiles: string[] = [];

  for (const artifact of essentialArtifacts) {
    const filePath = path.join(backupPath, artifact);
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile() || stats.size === 0) {
        corruptedFiles.push(artifact);
      }
    } catch {
      missingArtifacts.push(artifact);
    }
  }

  // Gracefully allow analysis to proceed even if non-critical artifacts are missing,
  // recording the state accurately in the verification result object.
  return {
    isValid: missingArtifacts.length === 0 && corruptedFiles.length === 0,
    missingArtifacts,
    corruptedFiles,
  };
}
