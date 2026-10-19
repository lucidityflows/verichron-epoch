/**
 * Every view's header has the same shape (owner, 2026-10-19): its title, one
 * sentence saying what the view is for, and, when it shows one, the
 * selected analysis beneath.
 */

import assert from 'node:assert/strict';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';

import { ViewLayout } from './ViewLayout';

afterEach(cleanup);

describe('ViewLayout header', () => {
  it('shows the description, and the context line only when there is one', () => {
    const { rerender } = render(
      <ViewLayout section="reports" title="Reports" description="The investigation report." context={null}>
        <p>body</p>
      </ViewLayout>
    );
    assert.ok(screen.getByRole('heading', { name: 'Reports' }));
    assert.ok(screen.getByText('The investigation report.'));
    assert.equal(screen.queryByText(/Analysis/), null);
    rerender(
      <ViewLayout
        section="reports"
        title="Reports"
        description="The investigation report."
        context="iPhone17,5 · iOS 26.6.1 · Investigation aaaaaaaa · Analysis 33333333"
      >
        <p>body</p>
      </ViewLayout>
    );
    assert.ok(screen.getByText('iPhone17,5 · iOS 26.6.1 · Investigation aaaaaaaa · Analysis 33333333'));
  });
});
