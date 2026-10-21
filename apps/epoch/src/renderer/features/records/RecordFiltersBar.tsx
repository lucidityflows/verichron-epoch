import { useEffect, useState } from 'react';
import type { FacetCount, RecordFacet, RecordFacets } from '@verichron/etl-db-reader';
import { Button } from '../../components/ui/Button';
import { wallTimeToInstant, type DisplayZone } from '../../../shared/time';
import type { RecordFilters } from './useRecords';
import { sourceTitle, tierLabel } from './recordText';
import { MentionsFilter } from './MentionsFilter';
import type { EntityOverview } from '../../../shared/types/window';

const count = (n: number) => n.toLocaleString('en-US');

/** Which filter each facet sets. */
const FILTER_OF: Record<RecordFacet, keyof RecordFilters> = {
  source: 'sourceType',
  category: 'category',
  module: 'module',
  artifact: 'artifact',
  tier: 'tier',
};

const FACETS: { facet: RecordFacet; label: string; all: string; name?: (value: string) => string }[] = [
  { facet: 'source', label: 'Source', all: 'All sources', name: sourceTitle },
  { facet: 'category', label: 'Category', all: 'All categories' },
  { facet: 'module', label: 'Module', all: 'All modules' },
  { facet: 'artifact', label: 'Artifact', all: 'All artifacts' },
  { facet: 'tier', label: 'Tier', all: 'All tiers', name: tierLabel },
];

/** A facet's choices: every value it has, with its count, zeros included; a chosen module narrows the artifacts. */
function choices(facet: RecordFacet, values: FacetCount[], filters: RecordFilters): (FacetCount & { value: string })[] {
  const named = values.filter((v): v is FacetCount & { value: string } => v.value !== null);
  if (facet === 'artifact' && filters.module) {
    return named.filter((v) => v.count > 0 || v.value === filters.artifact);
  }
  return named;
}

interface RecordFiltersBarProps {
  runId: string;
  /** What the records mention (EPOCH-581), for the Mentions filter. */
  entities: EntityOverview | null;
  filters: RecordFilters;
  facets: RecordFacets | null;
  zone: DisplayZone;
  onChange: (filters: RecordFilters) => void;
}

/**
 * Forensic Records' filters (EPOCH-556). Every count is the database's,
 * exact for the other filters in use (R25); a value the other filters
 * exclude is listed with 0, so an empty combination shows before it is
 * chosen. Times are typed in the examiner's zone.
 */
export function RecordFiltersBar({ runId, entities, filters, facets, zone, onChange }: RecordFiltersBarProps) {
  const [search, setSearch] = useState(filters.search ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [timeError, setTimeError] = useState<string | null>(null);

  // A search is read once typing pauses, not on every key.
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === (filters.search ?? '')) return;
    const timer = setTimeout(() => onChange({ ...filters, search: trimmed || undefined }), 300);
    return () => clearTimeout(timer);
  }, [search, filters, onChange]);

  const set = (key: keyof RecordFilters, value: string) => {
    const next: RecordFilters = { ...filters, [key]: value || undefined };
    // A new module starts from all its artifacts.
    if (key === 'module') delete next.artifact;
    onChange(next);
  };

  const applyTimes = (nextFrom: string, nextTo: string) => {
    try {
      const eventTimeFrom = nextFrom ? wallTimeToInstant(nextFrom, zone) : undefined;
      const eventTimeTo = nextTo ? wallTimeToInstant(nextTo, zone, true) : undefined;
      if (eventTimeFrom && eventTimeTo && eventTimeFrom > eventTimeTo) {
        setTimeError('The start is after the end.');
        return;
      }
      setTimeError(null);
      onChange({ ...filters, eventTimeFrom, eventTimeTo });
    } catch (err) {
      setTimeError(err instanceof Error ? err.message : String(err));
    }
  };

  // The order is not a filter: it neither narrows the records nor changes a count.
  const active = Object.entries(filters).some(([key, value]) => key !== 'direction' && value !== undefined);

  return (
    <div className="flex flex-col gap-2 mb-3 shrink-0">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 min-w-[14rem] flex-1">
          <span className="text-label text-muted-foreground">Search records</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Any value, such as a domain, app or name"
            className="bg-background border border-border focus:border-accent focus:outline-none rounded-lg px-2.5 py-1.5 text-data"
          />
        </label>
        {FACETS.map(({ facet, label, all, name }) => {
          const key = FILTER_OF[facet];
          const values = facets ? choices(facet, facets.facets[facet], filters) : [];
          return (
            <label key={facet} className="flex flex-col gap-1 min-w-[9rem] max-w-[14rem]">
              <span className="text-label text-muted-foreground">{label}</span>
              <select
                value={(filters[key] as string | undefined) ?? ''}
                onChange={(event) => set(key, event.target.value)}
                disabled={!facets}
                className="bg-background border border-border focus:border-accent focus:outline-none rounded-lg px-2.5 py-1.5 text-data truncate disabled:opacity-50"
              >
                <option value="">{all}</option>
                {values.map((v) => (
                  <option key={v.value} value={v.value}>
                    {(name ?? String)(v.value)} ({count(v.count)})
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <MentionsFilter
          runId={runId}
          overview={entities}
          kind={filters.mentionKind}
          value={filters.mentionValue}
          onChange={(mentionKind, mentionValue) => onChange({ ...filters, mentionKind, mentionValue })}
        />
        <label className="flex flex-col gap-1">
          <span className="text-label text-muted-foreground">From ({zone})</span>
          <input
            type="datetime-local"
            step={1}
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              applyTimes(event.target.value, to);
            }}
            className="bg-background border border-border focus:border-accent focus:outline-none rounded-lg px-2.5 py-1.5 text-data"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-label text-muted-foreground">To ({zone})</span>
          <input
            type="datetime-local"
            step={1}
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              applyTimes(from, event.target.value);
            }}
            className="bg-background border border-border focus:border-accent focus:outline-none rounded-lg px-2.5 py-1.5 text-data"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-label text-muted-foreground">Order</span>
          <select
            value={filters.direction ?? 'asc'}
            onChange={(event) =>
              onChange({ ...filters, direction: event.target.value === 'desc' ? 'desc' : undefined })
            }
            className="bg-background border border-border focus:border-accent focus:outline-none rounded-lg px-2.5 py-1.5 text-data"
          >
            <option value="asc">Oldest first</option>
            <option value="desc">Newest first</option>
          </select>
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={!active && !from && !to && !search}
          onClick={() => {
            setSearch('');
            setFrom('');
            setTo('');
            setTimeError(null);
            onChange({});
          }}
        >
          Clear Filters
        </Button>
        {timeError ? (
          <p role="alert" className="text-data text-warning">
            {timeError}
          </p>
        ) : (
          facets && (
            <p className="text-data text-muted-foreground flex-1 min-w-[16rem]" aria-live="polite">
              {count(facets.total)} record{facets.total === 1 ? '' : 's'}
              {active ? ' match these filters' : ''}
              {facets.untimed > 0 ? `, ${count(facets.untimed)} with no time recorded (listed last)` : ''}. Counts come
              from the database, not from the rows on screen.
            </p>
          )
        )}
      </div>
    </div>
  );
}
