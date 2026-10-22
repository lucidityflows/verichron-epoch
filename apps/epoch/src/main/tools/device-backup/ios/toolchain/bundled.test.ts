import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { BUNDLED_TOOLS, USBMUXD_UDEV_RULES, bundledSetup } from './bundled';
import type { Run } from './process';

const BIN = '/opt/epoch/bin';

function setup(present: string[]) {
  const files = new Set(present);
  const run: Run = async () => ({ code: 0, output: 'usbmuxd 1.1.1\n' });
  return bundledSetup(BIN, { platform: 'linux', run, exists: (file) => files.has(file), env: {} });
}

const allTools = BUNDLED_TOOLS.map((tool) => `${BIN}/${tool}`);

describe('iPhone import in the Lab bundle (EPOCH-472)', () => {
  it('is ready with the bundled tools, usbmuxd and its udev rules, and offers nothing to install', async () => {
    const status = await setup([...allTools, '/usr/sbin/usbmuxd', USBMUXD_UDEV_RULES]).status();
    assert.equal(status.installed, true);
    assert.equal(status.systemReady, true);
    assert.equal(status.install, null);
    assert.deepEqual(
      status.requirements.map((r) => [r.id, r.ok]),
      [
        ['usbmuxd', true],
        ['udev-rules', true],
        ['idevicebackup2', true],
        ['idevicecrashreport', true],
        ['idevice_id', true],
        ['ideviceinfo', true],
      ]
    );
  });

  it("without usbmuxd, shows the administrator's command and no install button", async () => {
    const status = await setup(allTools).status();
    assert.equal(status.systemReady, false);
    assert.deepEqual(status.install?.packages, ['usbmuxd']);
    assert.equal(
      status.install?.automatic,
      false,
      'no network, no admin prompt: the lab installs it from its own media'
    );
  });

  it('names a tool missing from the bundle, and offers no build for it', async () => {
    const status = await setup(allTools.filter((t) => !t.endsWith('/idevicebackup2'))).status();
    assert.equal(status.installed, false);
    assert.equal(status.supported, false, 'there is no setup to run: the bundle is incomplete');
    const missing = status.requirements.find((r) => r.id === 'idevicebackup2');
    assert.equal(missing?.ok, false);
    assert.match(missing?.detail ?? '', /Missing from the bundle/);
  });

  it('never installs or builds anything', async () => {
    const lab = setup(allTools);
    await assert.rejects(
      lab.installRequirements(() => undefined),
      /installs nothing/
    );
    await assert.rejects(
      lab.build(() => undefined),
      /installs nothing/
    );
  });
});
