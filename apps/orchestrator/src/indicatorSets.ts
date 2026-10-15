import { Client } from 'pg';

/** The registered indicator set a run checks (EPOCH-491). */
export interface IndicatorSetChoice {
  setId: string;
  setHash: string;
  name: string;
}

/** Thrown when the set asked for by hash isn't registered. */
export class IndicatorSetError extends Error {}

/**
 * The set a run checks: the one with the given set hash, or else the newest
 * registered set. Null when none is registered; the indicator-match stage is
 * then recorded as skipped, with the reason. One set per run: checking against
 * several sources together means registering one combined set (decided
 * 2026-10-15, project owner).
 */
export async function selectIndicatorSet(client: Client, setHash?: string): Promise<IndicatorSetChoice | null> {
  if (setHash !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(setHash)) {
      throw new IndicatorSetError(`--indicator-set must be a set hash (64 lowercase hex characters), not "${setHash}"`);
    }
    const { rows } = await client.query<{ set_id: string; set_hash: string; name: string }>(
      'SELECT set_id, set_hash, name FROM indicator_sets WHERE set_hash = $1',
      [setHash]
    );
    if (!rows[0]) throw new IndicatorSetError(`no indicator set with hash ${setHash} is registered`);
    return { setId: rows[0].set_id, setHash: rows[0].set_hash, name: rows[0].name };
  }
  const { rows } = await client.query<{ set_id: string; set_hash: string; name: string }>(
    'SELECT set_id, set_hash, name FROM indicator_sets ORDER BY registered_at DESC, set_hash LIMIT 1'
  );
  return rows[0] ? { setId: rows[0].set_id, setHash: rows[0].set_hash, name: rows[0].name } : null;
}
