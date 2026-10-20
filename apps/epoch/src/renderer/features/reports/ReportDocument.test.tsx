import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ReportDocument } from './ReportDocument';

afterEach(cleanup);

const REPORT = [
  '# Investigation Report',
  '',
  '**Evidence:** `e1`',
  '',
  '## Not Examined',
  '',
  'What this report did not look at. None of these is a clean result.',
  '',
  '- **Crash Reports did not run:** not acquired',
  '- **AI-assisted analysis:** not run.',
  '',
  '## Crash Reports',
  '',
  '| Time | Bug Type | Process |',
  '| :--- | :--- | :--- |',
  '| 2026-10-08 00:36:36 UTC | 145 · no label known | not recorded |',
  '',
  'See [the vendor](https://example.com/a) and ![a chart](https://example.com/chart.png).',
  '',
  '<script>window.injected = true</script>',
  '',
  '### `4F2A9C3E`',
  '- **Source file:** `JetsamEvent.ips`',
].join('\n');

describe('ReportDocument (EPOCH-552)', () => {
  it('renders tables, code and emphasis as such, with no Markdown syntax left', () => {
    const { container } = render(<ReportDocument markdown={REPORT} />);
    const article = container.querySelector('article')!;
    expect(within(article).getByRole('heading', { level: 1, name: 'Investigation Report' })).toBeTruthy();
    expect(within(article).getByRole('table')).toBeTruthy();
    expect(within(article).getByRole('cell', { name: '145 · no label known' })).toBeTruthy();
    expect(within(article).getByText('e1').tagName).toBe('CODE');
    expect(within(article).getByText('Evidence:').tagName).toBe('STRONG');
    for (const syntax of ['**', '| :---', '## ', '`']) expect(article.textContent).not.toContain(syntax);
  });

  it('keeps a wide table in its own scrolling box', () => {
    render(<ReportDocument markdown={REPORT} />);
    expect(screen.getByRole('table').parentElement?.className).toMatch(/overflow-x-auto/);
  });

  it('never follows a link, loads an image or runs HTML from a report', () => {
    const { container } = render(<ReportDocument markdown={REPORT} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('the vendor').getAttribute('title')).toBe('https://example.com/a');
    expect(screen.getByText('[image not shown: a chart]')).toBeTruthy();
  });

  it('lists the sections, leading with Not Examined and its count of items', () => {
    render(<ReportDocument markdown={REPORT} />);
    const contents = screen.getByRole('navigation', { name: 'In this report' });
    const entries = within(contents)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(entries).toEqual(['Not Examined · 2', 'Crash Reports']);
    expect(within(contents).getByRole('button', { name: /Not Examined/ }).className).toMatch(/text-warning/);
  });
});
