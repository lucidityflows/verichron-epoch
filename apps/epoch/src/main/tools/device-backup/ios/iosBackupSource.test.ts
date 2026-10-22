import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backupDeviceId, backupFinishedAt, deviceListed, incompleteReason } from './backupRun';
import { copyCrashReports, crashReportsCopyExists, discardCrashReportsCopy } from './crashReports';
import { IosBackupSource } from './iosBackupSource';
import { appendPullRecord } from './pullRecord';

vi.mock('../detection', () => ({
  bundledToolPath: (_prefix: string, name: string) => `/tools/${name}`,
  detectBinary: (name: string) => ({ available: true, path: `/tools/${name}` }),
}));
vi.mock('./iosAcquisitionStrategy', () => ({ idevicebackup2InstallPrefix: () => '/tools' }));
vi.mock('./toolchain', () => ({ manifestMatchesPins: () => true, readManifest: () => null }));
vi.mock('./backupRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./backupRun')>()),
  backupDeviceId: vi.fn(),
  backupFinishedAt: vi.fn(),
  deviceListed: vi.fn(),
  incompleteReason: vi.fn(),
}));
vi.mock('./crashReports', () => ({
  copyCrashReports: vi.fn(),
  crashReportsCopyExists: vi.fn(),
  discardCrashReportsCopy: vi.fn(),
}));
vi.mock('./pullRecord', () => ({ appendPullRecord: vi.fn() }));

const device = { id: 'test-device', name: 'Test iPhone' };
const firstBackup = '/acquisitions/first/test-device';
const secondBackup = '/acquisitions/second/test-device';
let source: IosBackupSource;

beforeEach(() => {
  vi.resetAllMocks();
  source = new IosBackupSource();
  vi.spyOn(source, 'listConnectedDevices').mockResolvedValue([device]);
  vi.mocked(incompleteReason).mockResolvedValue(null);
  vi.mocked(backupDeviceId).mockResolvedValue(device.id);
  vi.mocked(backupFinishedAt).mockResolvedValue('2026-10-15T00:00:00.000Z');
  vi.mocked(deviceListed).mockReturnValue(true);
  vi.mocked(crashReportsCopyExists).mockResolvedValue(false);
  vi.mocked(copyCrashReports).mockResolvedValue({ outcome: 'copied', tool_version: '1.4.0', files: 1, bytes: 4 });
  vi.mocked(appendPullRecord).mockResolvedValue(undefined);
  vi.mocked(discardCrashReportsCopy).mockResolvedValue(undefined);
});

function expectNoWrites() {
  expect(copyCrashReports).not.toHaveBeenCalled();
  expect(appendPullRecord).not.toHaveBeenCalled();
  expect(discardCrashReportsCopy).not.toHaveBeenCalled();
}

describe('crash-log retry target references', () => {
  it('keeps separate references for two backups of one device and rejects a substituted path', async () => {
    const { targets } = await source.findCrashReportsRetryTargets([firstBackup, secondBackup]);
    expect(targets).toHaveLength(2);
    expect(targets[0].deviceRef).not.toBe(targets[1].deviceRef);
    await expect(source.copyCrashReportsAgainByReference(targets[0].deviceRef, secondBackup)).rejects.toThrow(
      'does not match the selected retry target'
    );
    expectNoWrites();

    expect(await source.copyCrashReportsAgainByReference(targets[0].deviceRef, firstBackup)).toEqual({
      outcome: 'copied',
      backupDir: firstBackup,
      files: 1,
    });
    expect(copyCrashReports).toHaveBeenCalledWith(
      '/tools/idevicecrashreport',
      device.id,
      firstBackup,
      expect.any(String)
    );
    expect(appendPullRecord).toHaveBeenCalledWith(
      path.dirname(firstBackup),
      expect.objectContaining({ udid: device.id, path: firstBackup })
    );
  });

  it('rejects an unselected backup of the same device before any copy, record or cleanup', async () => {
    const { targets } = await source.findCrashReportsRetryTargets([firstBackup]);
    await expect(source.copyCrashReportsAgainByReference(targets[0].deviceRef, secondBackup)).rejects.toThrow(
      'does not match the selected retry target'
    );
    expectNoWrites();
  });

  it('rejects unknown and disconnected device references', async () => {
    const { targets } = await source.findCrashReportsRetryTargets([firstBackup]);
    await expect(source.copyCrashReportsAgainByReference('unknown', firstBackup)).rejects.toThrow(
      'reference is no longer available'
    );
    vi.mocked(source.listConnectedDevices).mockResolvedValue([]);
    await source.findCrashReportsRetryTargets([firstBackup]);
    await expect(source.copyCrashReportsAgainByReference(targets[0].deviceRef, firstBackup)).rejects.toThrow(
      'reference is no longer available'
    );
    expectNoWrites();
  });

  it('rechecks the originating device even when the backup path matches', async () => {
    const { targets } = await source.findCrashReportsRetryTargets([firstBackup]);
    vi.mocked(backupDeviceId).mockResolvedValue('another-device');
    await expect(source.copyCrashReportsAgainByReference(targets[0].deviceRef, firstBackup)).rejects.toThrow(
      'only from the same device'
    );
    expectNoWrites();
  });

  it('confines cleanup to the selected backup if its pull record cannot be written', async () => {
    const { targets } = await source.findCrashReportsRetryTargets([firstBackup]);
    vi.mocked(appendPullRecord).mockRejectedValue(new Error('record unavailable'));
    await expect(source.copyCrashReportsAgainByReference(targets[0].deviceRef, firstBackup)).rejects.toThrow(
      'so the copy was removed'
    );
    expect(discardCrashReportsCopy).toHaveBeenCalledTimes(1);
    expect(discardCrashReportsCopy).toHaveBeenCalledWith(firstBackup);
  });
});

describe('Lab bundle availability and pull refusal', () => {
  it('refuses availability and pull when host requirements or bundled tools are unmet', async () => {
    const customCtx = {
      platform: 'linux' as const,
      run: async () => ({ code: 1, output: '' }),
      exists: (file: string) => !file.includes('usbmuxd') && file !== '/opt/epoch/bin/idevicecrashreport',
      env: {},
    };
    const status = await source.checkToolAvailable(customCtx);
    // In checkout layout (default in test env), checkToolAvailable delegates to findTool('idevicebackup2')
    expect(status.available).toBe(true);

    // Now test with layout returning bundle layout
    const contracts = await import('@verichron/contracts');
    vi.spyOn(contracts, 'layout').mockReturnValue({
      kind: 'bundle',
      root: '/opt/epoch',
      source: '/opt/epoch/source',
      python: '/opt/epoch/runtime-venv/bin/python',
      pythonVersionFile: '/opt/epoch/source/.python-version',
      decryptPython: '/opt/epoch/tools/decrypt/python',
      decryptScript: '/opt/epoch/tools/decrypt/script.py',
      ileappDir: '/opt/epoch/tools/ileapp',
      ileappPython: '/opt/epoch/tools/ileapp/python',
      ileappCommitFile: null,
      postgresql: '/opt/epoch/postgresql',
      bin: '/opt/epoch/bin',
    });

    try {
      const bundleStatus = await source.checkToolAvailable(customCtx);
      expect(bundleStatus.available).toBe(false);
      if (!bundleStatus.available) {
        expect(bundleStatus.reason).toMatch(/Not ready for iPhone import:/);
        expect(bundleStatus.reason).toContain('usbmuxd');
        expect(bundleStatus.reason).toContain('idevicecrashreport');
      }

      await expect(
        source.pullBackup(
          device,
          '/dest',
          () => {},
          () => {},
          { password: 'secret', enableEncryption: false }
        )
      ).rejects.toThrow(/Not ready for iPhone import:/);
    } finally {
      vi.mocked(contracts.layout).mockRestore();
    }
  });
});
