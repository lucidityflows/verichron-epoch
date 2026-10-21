import type { EntityUnreadField } from '@verichron/etl-db-reader';
import type { EntityOverview } from '../../../shared/types/window';

const count = (n: number) => n.toLocaleString('en-US');

/**
 * What the entity rules read in this evidence, and every field they didn't
 * (EPOCH-581): a field with values and no rule is listed, so a gap in the
 * rules is never read as "nothing mentioned". Counts come from the database.
 */
export function EntityCoveragePanel({ overview, error }: { overview: EntityOverview | null; error: string | null }) {
  if (error) {
    return (
      <p role="alert" className="text-data text-warning mb-4 shrink-0">
        What the records mention could not be read: {error}
      </p>
    );
  }
  if (!overview) return null;
  const { kinds, coverage } = overview;
  if (coverage.units === 0) {
    return (
      <p className="text-data text-muted-foreground mb-4 shrink-0">
        Entities: not read for this evidence yet. Analyze again to read what its records mention; until then Mentions
        has nothing to offer, which is not a finding.
      </p>
    );
  }
  const sources = new Set(coverage.unread.map((f) => `${f.source_type}|${f.artifact}`)).size;
  const shaped = coverage.unread.filter((f) => Object.keys(f.shaped).length > 0);
  return (
    <section aria-labelledby="entities-title" className="card rounded-xl px-5 py-3 mb-4 shrink-0 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-data">
        <h2 id="entities-title" className="font-semibold text-foreground">
          Entities
        </h2>
        <p className="text-muted-foreground flex-1 min-w-0">
          {kinds.map((k, i) => (
            <span key={k.kind} className="whitespace-nowrap">
              {i > 0 && ' · '}
              <span className="font-semibold tabular-nums text-foreground">{count(k.values)}</span> {k.title}
              {k.values === 1 ? '' : ' values'} in {count(k.records)} records
            </span>
          ))}
          {kinds.length === 0 && 'No rule found a value in these records.'}
          {coverage.unreadable > 0 && ` · ${count(coverage.unreadable)} values in ruled fields didn't fit their kind`}
        </p>
      </div>
      {shaped.length > 0 && (
        <div className="text-data">
          <p className="text-warning">
            {count(shaped.length)} field{shaped.length === 1 ? '' : 's'} that no entity rule reads hold values shaped
            like an entity. Review these first: the shape suggests what they hold, but never decides it.
          </p>
          <FieldList fields={shaped} hints={overview.shapeHints} />
        </div>
      )}
      {coverage.unread.length > 0 && (
        <details className="text-data">
          <summary className="cursor-pointer text-muted-foreground">
            {count(coverage.unread.length)} field{coverage.unread.length === 1 ? '' : 's'} in {count(sources)} source
            {sources === 1 ? '' : 's'} hold values that no entity rule reads
          </summary>
          <FieldList fields={coverage.unread} hints={overview.shapeHints} />
        </details>
      )}
    </section>
  );
}

/** Each field, where it is, how many records held a value, and the shapes of those values. */
function FieldList({ fields, hints }: { fields: EntityUnreadField[]; hints: Record<string, string> }) {
  return (
    <ul className="mt-1 flex flex-col gap-0.5 max-h-64 overflow-auto">
      {fields.map((f) => (
        <li key={`${f.source_type}|${f.artifact}|${f.field}`} className="text-muted-foreground">
          <span className="text-foreground">{f.artifact ?? 'Crash Reports'}</span> ·{' '}
          <span className="font-mono">{f.field}</span>: {count(f.records)} record{f.records === 1 ? '' : 's'}
          {Object.entries(f.shaped).map(([hint, n]) => `; ${count(n)} shaped like a ${hints[hint] ?? hint}`)}
        </li>
      ))}
    </ul>
  );
}
