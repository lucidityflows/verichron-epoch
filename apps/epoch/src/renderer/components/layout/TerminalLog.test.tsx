/**
 * The log panel's lines read as they show when copied: time, level and
 * message separated by real spaces, never run together (EPOCH-570).
 */
import assert from 'node:assert/strict';
import { cleanup, render } from '@testing-library/react';
import type { TaskLogEntry } from '@verichron/contracts';
import { afterEach, describe, it } from 'vitest';

import { TerminalLog } from './TerminalLog';

afterEach(cleanup);

const entry = (
  seq: number,
  level: TaskLogEntry['level'],
  message: string,
  label: string | null = null
): TaskLogEntry => ({
  v: 1,
  task_id: '1f3a9c2e-0000-4000-8000-000000000001',
  seq,
  at: '2026-10-18T15:09:15.000Z',
  clock: 'received',
  level,
  source: 'app',
  label,
  step: null,
  kind: 'message',
  message,
});

describe('TerminalLog', () => {
  it('writes each entry with real spaces between its time, level, label and message', () => {
    const { container } = render(
      <TerminalLog
        lines={[entry(1, 'info', 'Analyze started for 1 backup'), entry(2, 'debug', 'the orchestrator started', 'BK')]}
        live={false}
        defaultOpen
      />
    );
    const rows = [...container.querySelectorAll('.whitespace-pre-wrap')].map((row) => row.textContent);
    assert.deepEqual(rows, [
      '15:09:15Z  INFO   Analyze started for 1 backup',
      '15:09:15Z  DEBUG  [BK] the orchestrator started',
    ]);
  });
});
