import { useEffect, useId, useState } from 'react';
import type { EntityValueRow } from '@verichron/etl-db-reader';
import { runsApi } from '../../api/runs';
import type { EntityOverview } from '../../../shared/types/window';

const count = (n: number) => n.toLocaleString('en-US');

/** Values offered while typing: the most-mentioned that match. */
const SUGGESTIONS = 50;

interface MentionsFilterProps {
  runId: string;
  overview: EntityOverview | null;
  /** The mention in use: both set, or neither. */
  kind: string | undefined;
  value: string | undefined;
  /** Called with both when a value is chosen, and with neither when it is cleared. */
  onChange: (kind: string | undefined, value: string | undefined) => void;
}

/**
 * "Mentions" (EPOCH-581): the records that mention one value of one kind, a
 * domain, an app, a phone number. The kinds and values are the database's,
 * read by the entity rules; a value is chosen from those found, never typed
 * freely, so a filter never reads as "none found" for a value no rule could
 * have read.
 */
export function MentionsFilter({ runId, overview, kind, value, onChange }: MentionsFilterProps) {
  const listId = useId();
  // The kind being browsed; a kind alone narrows nothing, so it is the filter's own until a value is chosen.
  const [browsing, setBrowsing] = useState(kind);
  const [text, setText] = useState(value ?? '');
  // Set when this filter cleared the mention itself, so the kind being browsed stays. State, not a
  // ref: it decides what the next render shows, when the cleared filters come back as props.
  const [clearedHere, setClearedHere] = useState(false);
  const [values, setValues] = useState<EntityValueRow[]>([]);
  const [total, setTotal] = useState(0);
  const [shownFor, setShownFor] = useState(`${kind}|${value}`);
  if (shownFor !== `${kind}|${value}`) {
    setShownFor(`${kind}|${value}`);
    if (clearedHere) {
      setClearedHere(false);
    } else {
      // Changed from outside (Clear Filters): show what is in use.
      setText(value ?? '');
      setBrowsing(kind);
    }
  }

  // The values matching what is typed, read once typing pauses.
  useEffect(() => {
    if (!browsing) return;
    let active = true;
    const timer = setTimeout(() => {
      runsApi
        .getEntityValues(runId, browsing, { search: text.trim() || undefined, limit: SUGGESTIONS })
        .then((page) => {
          if (!active) return;
          setValues(page.rows);
          setTotal(page.total);
        })
        .catch(() => active && setValues([]));
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [runId, browsing, text]);

  const kinds = overview?.kinds ?? [];
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 min-w-[9rem]">
        <span className="text-label text-muted-foreground">Mentions</span>
        <select
          value={browsing ?? ''}
          onChange={(event) => {
            setText('');
            setValues([]);
            setBrowsing(event.target.value || undefined);
            if (value !== undefined) {
              setClearedHere(true);
              onChange(undefined, undefined);
            }
          }}
          disabled={kinds.length === 0}
          className="bg-background border border-border focus:border-accent focus:outline-none rounded-lg px-2.5 py-1.5 text-data disabled:opacity-50"
        >
          <option value="">Any value</option>
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.title} ({count(k.values)})
            </option>
          ))}
        </select>
      </label>
      {browsing && (
        <label className="flex flex-col gap-1 min-w-[16rem] flex-1 max-w-[28rem]">
          <span className="text-label text-muted-foreground">
            {total > values.length
              ? `${count(total)} matching values; the ${count(values.length)} most mentioned are listed`
              : `${count(total)} matching value${total === 1 ? '' : 's'}`}
          </span>
          <input
            type="search"
            list={listId}
            value={text}
            placeholder="Type to find a value"
            onChange={(event) => {
              const typed = event.target.value;
              setText(typed);
              if (values.some((v) => v.value === typed)) {
                setClearedHere(true);
                onChange(browsing, typed);
              } else if (value !== undefined) {
                setClearedHere(true);
                onChange(undefined, undefined);
              }
            }}
            className="bg-background border border-border focus:border-accent focus:outline-none rounded-lg px-2.5 py-1.5 text-data font-mono"
          />
          <datalist id={listId}>
            {values.map((v) => (
              <option key={v.value} value={v.value}>
                {count(v.records)} record{v.records === 1 ? '' : 's'}
              </option>
            ))}
          </datalist>
        </label>
      )}
    </div>
  );
}
