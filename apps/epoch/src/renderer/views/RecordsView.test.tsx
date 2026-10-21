/**
 * Forensic Records (EPOCH-411, EPOCH-556): what was examined above the
 * records; filters whose counts come from the database; a module that
 * narrows the artifacts; a search read once typing pauses; and an opened
 * record that reads as a record, with what cites it.
 */

import assert from 'node:assert/strict';
import type {
  EvidenceCompleteness,
  ForensicRecordQuery,
  ForensicRecordRow,
  RecordDetail,
  RecordFacets,
} from '@verichron/etl-db-reader';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, it, vi } from 'vitest';

import { RecordsView } from './RecordsView';

const RUN = '33333333-0000-0000-0000-000000000003';

const SAFARI: ForensicRecordRow = {
  id: '20418',
  ingest_id: '1',
  evidence_id: 'e',
  derivative_id: 'd',
  file_hash: 'a'.repeat(64),
  parser_version: 6,
  incident_id: null,
  source_type: 'ileapp_record',
  event_time: '2026-10-14T10:12:09Z',
  bug_type: null,
  process_name: null,
  pid: null,
  bundle_id: null,
  fields: {
    source_artifact: 'Safari Browser - History',
    module: 'safariHistory',
    category: 'Safari Browser',
    source_path: 'private/var/mobile/Library/Safari/History.db',
    'Visit Timestamp': 1791972729,
    URL: 'https://update-check.example.invalid/a',
  },
  tier: 'observed',
};
const MATCH: ForensicRecordRow = {
  ...SAFARI,
  id: '40112',
  source_type: 'indicator_match',
  fields: { indicator: { type: 'domain', value: 'update-check.example.invalid' }, match_mode: 'url_host' },
  tier: 'tool_judgement',
};

const facets = (module?: string): RecordFacets => ({
  total: module ? 1 : 3,
  untimed: module ? 0 : 1,
  facets: {
    source: [
      { value: 'ileapp_record', count: module ? 1 : 2 },
      { value: 'indicator_match', count: module ? 0 : 1 },
    ],
    category: [{ value: 'Safari Browser', count: 1 }],
    module: [
      { value: 'safariHistory', count: 1 },
      { value: 'DataUsage', count: 1 },
    ],
    artifact: [
      { value: 'Safari Browser - History', count: 1 },
      { value: 'Data Usage', count: module ? 0 : 1 },
      { value: null, count: module ? 0 : 1 },
    ],
    tier: [
      { value: 'observed', count: module ? 1 : 2 },
      { value: 'tool_judgement', count: module ? 0 : 1 },
    ],
  },
});

const completeness: EvidenceCompleteness = {
  records: 3,
  artifacts_with_records: 2,
  stages: [
    {
      stage_name: 'crash',
      stage_title: 'Crash Reports',
      status: 'skipped',
      reason: 'crash logs were not acquired',
      run_id: RUN,
      finished_at: null,
      run_ended_reason: 'completed',
    },
  ],
  ileapp: {
    total: 540,
    complete: 114,
    found_none: 425,
    errored: [{ module: 'ZaloChats', artifact: 'zalo_messages', error: 'IndexError' }],
  },
};

const detail: RecordDetail = {
  record: SAFARI,
  file_path: '_lava_artifacts.db#safarihistory',
  produced_by_runs: [RUN],
  columns: [
    { column: 'visit_timestamp', header: 'Visit Timestamp', type: 'datetime' },
    { column: 'url', header: 'URL', type: null },
  ],
  used_by: [
    {
      match_id: '40112',
      indicator_type: 'domain',
      indicator_value: 'update-check.example.invalid',
      match_mode: 'url_host',
      set_name: 'mvt-2026-10-15',
    },
  ],
};

const queries: ForensicRecordQuery[] = [];

const answers: Record<string, unknown> = {
  getRecordFacets: async (_run: string, query: ForensicRecordQuery) => facets(query.module),
  getForensicRecords: async (_run: string, query: ForensicRecordQuery) => {
    queries.push(query);
    return { rows: query.module ? [SAFARI] : [SAFARI, MATCH], total: query.module ? 1 : 3, nextCursor: null };
  },
  getEvidenceCompleteness: async () => completeness,
  getRecordDetail: async () => detail,
  getEntityOverview: async () => ({
    kinds: [{ kind: 'domain', title: 'Domain', values: 2, records: 3 }],
    coverage: {
      units: 4,
      unreadable: 1,
      unread: [
        {
          source_type: 'ileapp_record',
          artifact: 'InteractionC - Contacts',
          field: 'Display Name',
          records: 7,
          shaped: { phone: 3 },
        },
        {
          source_type: 'ileapp_record',
          artifact: 'Safari Browser - History',
          field: 'Visit Count',
          records: 2,
          shaped: {},
        },
      ],
    },
    shapeHints: { phone: 'phone number' },
  }),
  getEntityValues: async () => ({
    rows: [{ value: 'update-check.example.invalid', records: 2, first_seen: null, last_seen: null }],
    total: 1,
  }),
  getStillFailing: async () => ({ rows: [], total: 0 }),
  getInterruptedStages: async () => [],
  getAnalysisState: async () => ({
    status: 'idle',
    startedAt: null,
    taskLog: null,
    workspace: null,
    log: [],
    kind: null,
    target: null,
    currentStage: null,
    result: null,
  }),
};

// Every other call answers as an idle main process does; a subscription returns its unsubscribe.
vi.stubGlobal(
  'epoch',
  new Proxy(answers, {
    get: (target, name: string) =>
      name in target ? target[name] : name.startsWith('on') ? () => () => undefined : async () => null,
  })
);

beforeAll(() => {
  // jsdom has no layout: give the virtualized table a size so it renders rows.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 900 });
});
beforeEach(() => {
  queries.length = 0;
});
afterEach(cleanup);

const show = () =>
  render(
    <RecordsView
      selectedRun
      runId={RUN}
      analysisName="iPhone 17,5 · iOS 26.6.1"
      evidenceRegistered
      onOpenInvestigations={() => undefined}
      onOpenIndicatorMatches={() => undefined}
    />
  );

describe('Forensic Records', () => {
  it('states what was examined above the records', async () => {
    show();
    const panel = await screen.findByRole('region', { name: 'Evidence Completeness' });
    assert.match(
      panel.textContent ?? '',
      /540 iLEAPP modules run: 114 completed, 425 found no files in the backup, 1 failed/
    );
    assert.match(panel.textContent ?? '', /Crash Reports skipped: crash logs were not acquired/);
    assert.match(panel.textContent ?? '', /iLEAPP module ZaloChats failed on zalo_messages: IndexError/);
  });

  it('lists every value with its database count, and says how many records have no time', async () => {
    show();
    const source = await screen.findByRole('combobox', { name: 'Source' });
    await waitFor(() => assert.ok(within(source).getByRole('option', { name: 'iLEAPP Artifacts (2)' })));
    assert.ok(within(source).getByRole('option', { name: 'Indicator Matches (1)' }));
    assert.ok(screen.getByText(/3 records, 1 with no time recorded \(listed last\)/));
    const tier = screen.getByRole('combobox', { name: 'Tier' });
    assert.ok(within(tier).getByRole('option', { name: 'Tool judgement (1)' }));
  });

  it('narrows the artifacts to the module chosen, and reads the records again from the database', async () => {
    show();
    const module = await screen.findByRole('combobox', { name: 'Module' });
    await waitFor(() => assert.ok(within(module).getByRole('option', { name: 'safariHistory (1)' })));
    await act(async () => fireEvent.change(module, { target: { value: 'safariHistory' } }));
    await waitFor(() => assert.equal(queries.at(-1)?.module, 'safariHistory'));
    const artifact = screen.getByRole('combobox', { name: 'Artifact' });
    await waitFor(() =>
      assert.deepEqual(
        within(artifact)
          .getAllByRole('option')
          .map((o) => o.textContent),
        ['All artifacts', 'Safari Browser - History (1)']
      )
    );
    const source = screen.getByRole('combobox', { name: 'Source' });
    assert.ok(within(source).getByRole('option', { name: 'Indicator Matches (0)' }), 'a zero is listed, not hidden');
  });

  it('orders by time, oldest or newest first, without changing the counts', async () => {
    show();
    const order = await screen.findByRole('combobox', { name: 'Order' });
    await act(async () => fireEvent.change(order, { target: { value: 'desc' } }));
    await waitFor(() => assert.equal(queries.at(-1)?.direction, 'desc'));
    assert.ok(
      screen.getByText(/3 records, 1 with no time recorded/),
      'not "match these filters": order is not a filter'
    );
  });

  it('searches once typing pauses', async () => {
    show();
    const search = await screen.findByRole('searchbox', { name: 'Search records' });
    fireEvent.change(search, { target: { value: 'update-check' } });
    await waitFor(() => assert.equal(queries.at(-1)?.search, 'update-check'), { timeout: 2000 });
  });

  it('opens a record as a record: readable fields, where it came from, and what cites it', async () => {
    show();
    const row = await screen.findByText('https://update-check.example.invalid/a');
    await act(async () => fireEvent.click(row));
    const fields = await screen.findByRole('region', { name: 'Record fields' });
    assert.match(fields.textContent ?? '', /Visit Timestamp2026-10-14 10:12:09 UTC/);
    assert.doesNotMatch(fields.textContent ?? '', /1791972729/, 'stored seconds only when asked for');
    await act(async () => fireEvent.click(screen.getByRole('checkbox', { name: 'Show stored values' })));
    assert.match(fields.textContent ?? '', /stored: 1791972729/);
    const origin = screen.getByRole('region', { name: 'Where it came from' });
    assert.match(origin.textContent ?? '', /iLEAPP · safariHistory/);
    assert.match(
      origin.textContent ?? '',
      /Matched domain update-check.example.invalid \(url_host\) in set mvt-2026-10-15/
    );
    assert.ok(screen.getByRole('button', { name: 'Copy Raw Data' }));
  });

  it('says what the records mention and every field no entity rule reads (EPOCH-581)', async () => {
    show();
    const panel = await screen.findByRole('region', { name: 'Entities' });
    assert.match(panel.textContent ?? '', /2 Domain values in 3 records/);
    assert.match(panel.textContent ?? '', /1 values in ruled fields didn't fit their kind/);
    assert.match(panel.textContent ?? '', /1 field that no entity rule reads hold values shaped like an entity/);
    assert.match(
      panel.textContent ?? '',
      /InteractionC - Contacts · Display Name: 7 records; 3 shaped like a phone number/
    );
    assert.match(panel.textContent ?? '', /2 fields in 2 sources hold values that no entity rule reads/);
    assert.match(panel.textContent ?? '', /Safari Browser - History · Visit Count: 2 records/);
  });

  it('narrows the records to those that mention a value chosen from the values found', async () => {
    show();
    const mentions = await screen.findByRole('combobox', { name: 'Mentions' });
    await waitFor(() => assert.ok(within(mentions).getByRole('option', { name: 'Domain (2)' })));
    await act(async () => fireEvent.change(mentions, { target: { value: 'domain' } }));
    const value = await screen.findByPlaceholderText('Type to find a value');
    await screen.findByText('1 matching value');
    await act(async () => fireEvent.change(value, { target: { value: 'update-check' } }));
    assert.equal(queries.at(-1)?.mentionValue, undefined, 'a partial value narrows nothing');
    await act(async () => fireEvent.change(value, { target: { value: 'update-check.example.invalid' } }));
    await waitFor(() =>
      assert.deepEqual(
        [queries.at(-1)?.mentionKind, queries.at(-1)?.mentionValue],
        ['domain', 'update-check.example.invalid']
      )
    );
  });
});
