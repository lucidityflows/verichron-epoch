import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADMIN, APP_LOGIN, PG_HBA, databaseUrl, pgIdent, serverPaths } from './server.js';

describe('the bundle database server (EPOCH-477)', () => {
  it('keeps its data under XDG_DATA_HOME and its socket under XDG_RUNTIME_DIR', () => {
    assert.deepEqual(serverPaths({ XDG_DATA_HOME: '/d', XDG_RUNTIME_DIR: '/run/user/1000' }, '/home/x'), {
      dataDir: '/d/verichron-epoch/postgresql',
      readyMarker: '/d/verichron-epoch/postgresql.ready',
      logFile: '/d/verichron-epoch/postgresql.log',
      socketDir: '/run/user/1000/verichron-epoch',
    });
  });

  it('defaults the data directory to ~/.local/share, and ignores a relative one, as the XDG rules say', () => {
    for (const XDG_DATA_HOME of [undefined, 'relative/path']) {
      assert.equal(
        serverPaths({ XDG_DATA_HOME, XDG_RUNTIME_DIR: '/run/user/1000' }, '/home/x').dataDir,
        '/home/x/.local/share/verichron-epoch/postgresql'
      );
    }
  });

  it('refuses to guess a socket directory when XDG_RUNTIME_DIR is missing or relative', () => {
    for (const XDG_RUNTIME_DIR of [undefined, 'run/user/1000']) {
      assert.throws(() => serverPaths({ XDG_RUNTIME_DIR }, '/home/x'), /XDG_RUNTIME_DIR is not set/);
    }
  });

  it('connects over the socket with no password, the path encoded', () => {
    assert.equal(
      databaseUrl(APP_LOGIN, '/run/user/1000/verichron-epoch'),
      'postgresql://epoch_app@/verichron_epoch?host=%2Frun%2Fuser%2F1000%2Fverichron-epoch'
    );
    assert.doesNotMatch(databaseUrl(ADMIN, '/s'), /:[^/]*@/, 'no password in the address');
  });

  it('accepts local peer connections only, mapped to the two roles and nothing else', () => {
    assert.deepEqual(
      PG_HBA.split('\n').filter((line) => line && !line.startsWith('#')),
      ['local all all peer map=epoch']
    );
    assert.deepEqual(
      pgIdent('examiner')
        .split('\n')
        .filter((line) => line && !line.startsWith('#')),
      ['epoch examiner verichron_epoch_admin', 'epoch examiner epoch_app']
    );
  });
});
