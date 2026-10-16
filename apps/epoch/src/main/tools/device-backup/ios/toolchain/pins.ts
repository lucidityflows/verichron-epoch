/**
 * The iPhone libraries Epoch builds for device import, pinned to release
 * tarballs and verified by SHA-256 (EPOCH-465). Release tarballs ship a
 * generated `configure`, so building them needs no autotools. Each hash
 * matches the digest GitHub publishes for the asset.
 *
 * Listed in dependency order: glue, libusbmuxd and libtatsu need libplist;
 * libusbmuxd also needs glue; libimobiledevice needs all four. Updating a
 * version is a deliberate change: new tarball, new hash, and a check that the
 * minimums in each library's configure.ac are still met.
 */
export interface PinnedComponent {
  name: string;
  version: string;
  url: string;
  sha256: string;
  /** Extra ./configure arguments. */
  configureArgs: string[];
}

const release = (repo: string, version: string) =>
  `https://github.com/libimobiledevice/${repo}/releases/download/${version}/${repo}-${version}.tar.bz2`;

export const PINNED_COMPONENTS: readonly PinnedComponent[] = [
  {
    name: 'libplist',
    version: '2.8.0',
    url: release('libplist', '2.8.0'),
    sha256: 'b1f59f7634c58b2481325a23ff4e3bf51574a42d868cbe466d2b39b04550752a',
    configureArgs: ['--without-cython'],
  },
  {
    name: 'libimobiledevice-glue',
    version: '1.3.3',
    url: release('libimobiledevice-glue', '1.3.3'),
    sha256: '920ce01382a32695f49b23292b4979a03f0afd16c58e8755d8b7f41804acc1a9',
    configureArgs: [],
  },
  {
    name: 'libusbmuxd',
    version: '2.1.1',
    url: release('libusbmuxd', '2.1.1'),
    sha256: '5546f1aba1c3d1812c2b47d976312d00547d1044b84b6a461323c621f396efce',
    configureArgs: [],
  },
  {
    name: 'libtatsu',
    version: '1.0.5',
    url: release('libtatsu', '1.0.5'),
    sha256: '536fa228b14f156258e801a7f4d25a3a9dd91bb936bf6344e23171403c57e440',
    configureArgs: [],
  },
  {
    name: 'libimobiledevice',
    version: '1.4.0',
    url: release('libimobiledevice', '1.4.0'),
    sha256: '23cc0077e221c7d991bd0eb02150a0d49199bcca1ddf059edccee9ffd914939d',
    configureArgs: ['--without-cython'],
  },
];

export const archiveName = (c: PinnedComponent) => `${c.name}-${c.version}.tar.bz2`;
export const sourceDirName = (c: PinnedComponent) => `${c.name}-${c.version}`;
