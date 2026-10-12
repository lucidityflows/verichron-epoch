/**
 * The running pull as the main process tracks it (EPOCH-467), so a panel
 * that mounts mid-pull shows that pull instead of offering another.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeviceInfo } from '../../../shared/types/tools';
import { nextDeviceAction, PULL_STATE_PROGRESS_LIMIT, PullStateTracker } from './pullState';

const IPHONE: DeviceInfo = {
  id: '00008140-0000000000000000',
  name: 'iPhone',
  model: 'iPhone17,5',
  osVersion: '26.6.1',
};

describe('PullStateTracker', () => {
  it('has no state until a pull starts, and none after it ends', () => {
    const pull = new PullStateTracker();
    assert.equal(pull.current(), null);
    pull.start('ios', IPHONE, '/backups', 1000);
    assert.deepEqual(pull.current(), {
      sourceId: 'ios',
      device: IPHONE,
      destDir: '/backups',
      startedAt: 1000,
      progress: [],
      stats: null,
      deviceAction: null,
      ended: false,
    });
    pull.end();
    assert.equal(pull.current(), null);
    assert.equal(pull.running(), false);
  });

  it('refuses a second pull while one runs', () => {
    const pull = new PullStateTracker();
    pull.start('ios', IPHONE, '/backups');
    assert.throws(() => pull.start('ios', IPHONE, '/elsewhere'), /already in progress/);
    assert.equal(pull.current()?.destDir, '/backups');
  });

  it('keeps progress, the device-action banner and the latest stats', () => {
    const pull = new PullStateTracker();
    pull.start('ios', IPHONE, '/backups');
    pull.progress({ phase: 'device-action', message: 'Unlock iPhone.' });
    pull.progress({ phase: 'preparing', message: 'Full backup mode.' });
    assert.equal(pull.current()?.deviceAction, 'Unlock iPhone.');
    pull.progress({ phase: 'transferring', message: 'Receiving files' });
    assert.equal(pull.current()?.deviceAction, null);
    const stats = { startedAt: 1, receivedBytes: 10, lastDataAt: 2, percent: 1, estimatedBytes: 1000 };
    pull.stats(stats);
    assert.deepEqual(pull.current()?.stats, stats);
    assert.equal(pull.current()?.progress.length, 3);
  });

  it('keeps only the newest progress lines', () => {
    const pull = new PullStateTracker();
    pull.start('ios', IPHONE, '/backups');
    for (let i = 0; i < PULL_STATE_PROGRESS_LIMIT + 5; i++)
      pull.progress({ phase: 'transferring', message: `line ${i}` });
    const progress = pull.current()?.progress ?? [];
    assert.equal(progress.length, PULL_STATE_PROGRESS_LIMIT);
    assert.equal(progress[0].message, 'line 5');
  });

  it('notes when the pull reported its end', () => {
    const pull = new PullStateTracker();
    pull.start('ios', IPHONE, '/backups');
    assert.equal(pull.reportedEnd(), false);
    pull.progress({ phase: 'error', message: 'ErrorCode 208: Device locked' });
    assert.equal(pull.reportedEnd(), true);
    assert.equal(pull.current()?.ended, true);
  });

  it('names the backup it is writing, so it is not offered as incomplete', () => {
    const pull = new PullStateTracker();
    assert.equal(pull.writes('/backups', IPHONE.id), false);
    pull.start('ios', IPHONE, '/backups');
    assert.equal(pull.writes('/backups', IPHONE.id), true);
    assert.equal(pull.writes('/elsewhere', IPHONE.id), false);
    assert.equal(pull.writes('/backups', 'another-device'), false);
  });
});

describe('nextDeviceAction', () => {
  it('stays up through setup lines and clears on any other phase', () => {
    assert.equal(
      nextDeviceAction(null, { phase: 'device-action', message: 'Enter the passcode.' }),
      'Enter the passcode.'
    );
    assert.equal(
      nextDeviceAction('Enter the passcode.', { phase: 'preparing', message: 'Full backup mode.' }),
      'Enter the passcode.'
    );
    assert.equal(nextDeviceAction('Enter the passcode.', { phase: 'done', message: 'Backup complete.' }), null);
  });
});
