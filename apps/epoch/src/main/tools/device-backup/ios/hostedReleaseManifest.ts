import type { ExpectedChecksum } from '../verification';

/**
 * Manifest shape for a "download our own verified release" flow, similar
 * to how Qubes OS publishes signed/checksummed ISOs rather than pointing
 * users at unverified third-party mirrors.
 *
 * IMPORTANT: `releaseUrl` below is a placeholder, not a real, working
 * download. Standing up the actual release -- compiling libimobiledevice
 * for each platform in CI, publishing it somewhere, generating real
 * checksums -- is a separate infrastructure task (a build/sign/publish
 * pipeline) that doesn't exist yet. This manifest is the *consumer* side:
 * once a real release exists at a real URL with real checksums, updating
 * this file is the only change needed here. Nothing in
 * hostedReleaseAcquisition.ts should be changed to make that work.
 */
export interface HostedReleaseManifest {
  releaseUrl: string;
  checksums: ExpectedChecksum[];
}

export function hostedReleaseManifestFor(platform: NodeJS.Platform, arch: string): HostedReleaseManifest {
  // TODO: replace with a real URL + real checksums once VeriChron actually
  // publishes a built, signed idevicebackup2 release. Every value below is
  // a placeholder -- do not point production code at this until then.
  return {
    releaseUrl: `https://github.com/vermiliontides/verichron-epoch/releases/download/idevicebackup2-tools/idevicebackup2-${platform}-${arch}.tar.gz`,
    checksums: [{ algorithm: 'sha256', value: 'PLACEHOLDER_NOT_A_REAL_CHECKSUM' }],
  };
}
