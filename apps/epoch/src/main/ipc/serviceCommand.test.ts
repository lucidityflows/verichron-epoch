import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { Layout } from '@verichron/contracts';
import { serviceCommand } from './serviceCommand';

function at(kind: Layout['kind'], root: string): Layout {
  const source = kind === 'bundle' ? `${root}/source` : root;
  return {
    kind,
    root,
    source,
    python: `${root}/${kind === 'bundle' ? 'runtime-venv' : '.venv'}/bin/python`,
    pythonVersionFile: `${source}/.python-version`,
    decryptPython: `${root}/tools/decrypt/.venv/bin/python`,
    decryptScript: `${root}/tools/decrypt/decrypt_backup.py`,
    ileappDir: `${root}/tools/ileapp/iLEAPP`,
    ileappPython: `${root}/tools/ileapp/.venv/bin/python`,
    ileappCommitFile: kind === 'bundle' ? `${root}/tools/ileapp/iLEAPP.commit` : null,
  };
}

describe('serviceCommand (EPOCH-478)', () => {
  it('in a checkout, runs each service through pnpm, silently, from the root', () => {
    const lay = at('checkout', '/repo');
    assert.deepEqual(serviceCommand(lay, 'orchestrator', ['--workspace', '/ws']), {
      command: 'pnpm',
      args: ['--silent', '--filter', '@verichron/orchestrator', 'investigate', '--', '--workspace', '/ws'],
      cwd: '/repo',
    });
    assert.deepEqual(serviceCommand(lay, 'processor', ['--source', '/src']).args, [
      '--silent',
      '--filter',
      '@verichron/processor',
      'dev',
      '--',
      '--source',
      '/src',
    ]);
  });

  it('in the Lab bundle, runs the compiled service with the bundled Node: no pnpm, no PATH lookup', () => {
    const lay = at('bundle', '/opt/epoch');
    assert.deepEqual(serviceCommand(lay, 'orchestrator', ['--workspace', '/ws']), {
      command: '/opt/epoch/node/bin/node',
      args: ['/opt/epoch/services/orchestrator.mjs', '--workspace', '/ws'],
      cwd: '/opt/epoch',
    });
    assert.deepEqual(serviceCommand(lay, 'processor', ['--source', '/src']).args, [
      '/opt/epoch/services/processor.mjs',
      '--source',
      '/src',
    ]);
  });
});
