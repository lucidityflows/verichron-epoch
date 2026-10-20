import { describe, expect, it } from 'vitest';

import { notExaminedCount, splitReport } from './reportSections';

const REPORT = [
  '# Investigation Report',
  '',
  '**Evidence:** `e1`',
  '',
  '## Not Examined',
  '',
  '- **Crash Reports did not run:** not acquired',
  '',
  '## Crash Reports',
  '',
  '| Time | Bug Type |',
  '| :--- | :--- |',
  '| 2026-10-08 00:36:36 UTC | 145 · no label known |',
  '',
  '### `A`',
  '- **Source file:** `a.ips`',
  '',
  '### `B`',
  '- **Source file:** `b.ips`',
].join('\n');

describe('splitReport (EPOCH-552)', () => {
  it('cuts the report into the title block, a section per ## and a chunk per ###', () => {
    const sections = splitReport(REPORT);
    expect(sections.map((s) => [s.id, s.title, s.chunks.length])).toEqual([
      ['report-section-0', null, 1],
      ['report-section-1', 'Not Examined', 1],
      ['report-section-2', 'Crash Reports', 3],
    ]);
    expect(sections[2].chunks[0]).toContain('| 2026-10-08 00:36:36 UTC | 145 · no label known |');
    expect(sections[2].chunks[1]).toBe('### `A`\n- **Source file:** `a.ips`\n');
  });

  it('keeps every line, in order, so nothing in the report is lost', () => {
    const joined = splitReport(REPORT)
      .flatMap((s) => s.chunks)
      .join('\n');
    expect(joined).toBe(REPORT);
  });

  it('does not cut at a heading inside a code block', () => {
    const sections = splitReport('## A\n```\n## not a heading\n```\n');
    expect(sections.map((s) => s.title)).toEqual(['A']);
  });

  it('counts the Not Examined items, not their nested details, and nothing when there is no such section', () => {
    expect(notExaminedCount(splitReport(REPORT))).toBe(1);
    const nested =
      '## Not Examined\n- **iLEAPP plugins that errored**: 1.\n  - `Zalo Messages`\n- **AI-assisted analysis:** not run.';
    expect(notExaminedCount(splitReport(nested))).toBe(2);
    expect(notExaminedCount(splitReport('## Coverage\n- one'))).toBeNull();
  });
});
