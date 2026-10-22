/** Forensic Records' paging (EPOCH-556): a failed page is not read again on its own. */

import assert from 'node:assert/strict';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, vi } from 'vitest';

import { useRecords } from './useRecords';

describe('useRecords', () => {
  it('stops reading further pages after one fails, until the filters change', async () => {
    let reads = 0;
    vi.stubGlobal('epoch', {
      invoke: async (channel: string, _run: string, query: { cursor?: string }) => {
        if (channel === 'epoch:getRecordFacets') return { total: 2, untimed: 0, facets: {} };
        if (channel === 'epoch:getForensicRecords') {
          reads += 1;
          if (query.cursor) throw new Error('connection refused');
          return { rows: [{ id: '1' }], total: 2, nextCursor: 'next' };
        }
        throw new Error(`Unexpected IPC invoke: ${channel}`);
      },
      on: () => () => undefined,
    });
    const { result, rerender } = renderHook(({ filters }) => useRecords('run', filters), {
      initialProps: { filters: {} },
    });
    await waitFor(() => assert.equal(result.current.rows.length, 1));
    await act(async () => result.current.loadMore());
    await waitFor(() => assert.equal(result.current.error, 'connection refused'));
    // Asked again, as the table does when the last rows stay in view: nothing is read.
    await act(async () => result.current.loadMore());
    await act(async () => result.current.loadMore());
    assert.equal(reads, 2, 'the first page and the one failed page');
    rerender({ filters: { search: 'x' } });
    await waitFor(() => assert.equal(reads, 3, 'new filters read again'));
    vi.unstubAllGlobals();
  });
});
