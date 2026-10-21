import { useEffect, useState } from 'react';
import { runsApi } from '../../api/runs';
import type { EntityOverview } from '../../../shared/types/window';

/** What one investigation's records mention, and what the rules didn't read (EPOCH-581); null until read. */
export function useEntityOverview(runId: string | null): { overview: EntityOverview | null; error: string | null } {
  const [overview, setOverview] = useState<EntityOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readFor, setReadFor] = useState<string | null>(null);
  if (readFor !== runId) {
    setReadFor(runId);
    setOverview(null);
    setError(null);
  }
  useEffect(() => {
    if (!runId) return;
    let active = true;
    runsApi
      .getEntityOverview(runId)
      .then((answer) => active && setOverview(answer))
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      active = false;
    };
  }, [runId]);
  return { overview, error };
}
