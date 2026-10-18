/**
 * EPOCH-455: the shared UI primitives' behaviour. A Disclosure toggles and
 * says so; a CopyButton confirms or says it failed; a Toast is announced,
 * successes close themselves and failures stay until dismissed.
 */

import assert from 'node:assert/strict';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { CopyButton } from './CopyButton';
import { Disclosure } from './Disclosure';
import { ListSkeleton, TableSkeleton } from './Skeleton';
import { TOAST_DURATION_MS, ToastProvider, useToast, type ToastTone } from './Toast';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Disclosure', () => {
  it('starts closed, opens and closes, and reports its state', () => {
    render(
      <Disclosure label="Show full output" openLabel="Hide full output">
        <p>the full output</p>
      </Disclosure>
    );
    const toggle = screen.getByRole('button', { name: 'Show full output' });
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(screen.queryByText('the full output'), null);

    fireEvent.click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.ok(screen.getByText('the full output'));
    assert.ok(screen.getByRole('button', { name: 'Hide full output' }));

    fireEvent.click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(screen.queryByText('the full output'), null);
  });

  it('is a native button, so Enter and Space toggle it', () => {
    render(<Disclosure label="More">x</Disclosure>);
    const toggle = screen.getByRole('button', { name: 'More' });
    assert.equal(toggle.tagName, 'BUTTON');
    assert.equal(toggle.getAttribute('type'), 'button');
  });

  it('can start open', () => {
    render(
      <Disclosure label="More" defaultOpen>
        <p>shown</p>
      </Disclosure>
    );
    assert.ok(screen.getByText('shown'));
  });
});

describe('CopyButton', () => {
  beforeEach(() => vi.useFakeTimers());

  function stubClipboard(writeText: (text: string) => Promise<void>) {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(writeText) } });
    return navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
  }

  it('copies the text, confirms with "Copied", then returns to "Copy"', async () => {
    const writeText = stubClipboard(async () => {});
    render(<CopyButton text="stage output" />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Copy/ })));
    assert.deepEqual(writeText.mock.calls, [['stage output']]);
    assert.ok(screen.getByText('Copied'));

    act(() => vi.advanceTimersByTime(2000));
    assert.equal(screen.queryByText('Copied'), null);
    assert.ok(screen.getByText('Copy'));
  });

  it('reads a function at click time', async () => {
    const writeText = stubClipboard(async () => {});
    let value = 'before';
    render(<CopyButton text={() => value} />);
    value = 'after';
    await act(async () => fireEvent.click(screen.getByRole('button')));
    assert.deepEqual(writeText.mock.calls, [['after']]);
  });

  it('says "Copy failed" when the clipboard refuses', async () => {
    stubClipboard(async () => {
      throw new Error('denied');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<CopyButton text="x" />);
    await act(async () => fireEvent.click(screen.getByRole('button')));
    assert.ok(screen.getByText('Copy failed'));
    assert.equal(screen.queryByText('Copied'), null);
  });
});

describe('Toast', () => {
  beforeEach(() => vi.useFakeTimers());

  function Trigger({ message, tone }: { message: string; tone?: ToastTone }) {
    const toast = useToast();
    return (
      <button type="button" onClick={() => toast.show(message, tone)}>
        trigger
      </button>
    );
  }

  function show(message: string, tone?: ToastTone) {
    render(
      <ToastProvider>
        <Trigger message={message} tone={tone} />
      </ToastProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'trigger' }));
  }

  it('announces a success politely, and closes it after a while', () => {
    show('Report saved', 'success');
    const region = screen.getByRole('status');
    assert.equal(region.getAttribute('aria-live'), 'polite');
    assert.ok(region.textContent?.includes('Report saved'));

    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS));
    assert.equal(screen.queryByText('Report saved'), null);
  });

  it('announces a failure at once, and keeps it until it is dismissed', () => {
    show('Could not read the report', 'danger');
    const alert = screen.getByRole('alert');
    assert.equal(alert.getAttribute('aria-live'), 'assertive');
    assert.ok(alert.textContent?.includes('Could not read the report'));

    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS * 10));
    assert.ok(screen.getByText('Could not read the report'));

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    assert.equal(screen.queryByText('Could not read the report'), null);
  });

  it('refuses to be used outside its provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    assert.throws(() => render(<Trigger message="x" />), /inside ToastProvider/);
  });
});

describe('TableSkeleton', () => {
  it('draws a header and the rows, and says it is loading', () => {
    const { container } = render(<TableSkeleton columns={4} rows={2} />);
    const table = screen.getByLabelText('Loading');
    assert.equal(table.getAttribute('aria-busy'), 'true');
    assert.equal(container.querySelectorAll('.animate-pulse').length, 4 * 3, 'a header and two rows of four');
  });
});

describe('ListSkeleton', () => {
  it('draws the list’s cards, and says it is loading', () => {
    const { container } = render(<ListSkeleton rows={2} />);
    assert.equal(screen.getByLabelText('Loading').getAttribute('aria-busy'), 'true');
    assert.equal(container.querySelectorAll('.animate-pulse').length, 2 * 3, 'two cards of three lines');
  });
});
