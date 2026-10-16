import assert from 'node:assert/strict';
import test from 'node:test';
import { provenanceKey, type DecryptParams } from '@verichron/contracts';

const TOOL = { name: 'iphone_backup_decrypt', version: '0.10.0' };
const repaired = (preserved: string[], failed: string[] = []): DecryptParams => ({
  repair: {
    status: 'ran',
    tool: { name: 'sqlite3', version: '3.46.1' },
    scanned: 634,
    repaired: preserved.length,
    failed_files: failed,
    preserved_originals: preserved,
  },
});

test('when originals were preserved is not part of a decrypt’s identity (EPOCH-517)', () => {
  // The real names from the reference backup's two decrypts.
  const first = repaired(['01/0199c306c542fd45e762efc6074202baa94cb690.corrupt-2026-10-13T17-51-48-583Z']);
  const again = repaired(['01/0199c306c542fd45e762efc6074202baa94cb690.corrupt-2026-10-15T00-24-33-652Z']);
  assert.equal(provenanceKey(TOOL, first), provenanceKey(TOOL, again));
});

test('the order the repair met the databases in is not part of it either', () => {
  const a = repaired(['a.db.corrupt-2026-10-13T17-51-48-583Z', 'b.db.corrupt-2026-10-13T17-51-49-001Z']);
  const b = repaired(['b.db.corrupt-2026-10-15T00-24-33-652Z', 'a.db.corrupt-2026-10-15T00-24-34-100Z']);
  assert.equal(provenanceKey(TOOL, a), provenanceKey(TOOL, b));
});

test('which databases were repaired, and the outcome, still are', () => {
  const base = repaired(['a.db.corrupt-2026-10-13T17-51-48-583Z']);
  assert.notEqual(provenanceKey(TOOL, base), provenanceKey(TOOL, repaired(['b.db.corrupt-2026-10-13T17-51-48-583Z'])));
  assert.notEqual(
    provenanceKey(TOOL, base),
    provenanceKey(TOOL, repaired(['a.db.corrupt-2026-10-13T17-51-48-583Z'], ['a.db']))
  );
  assert.notEqual(provenanceKey(TOOL, base), provenanceKey({ ...TOOL, version: '0.11.0' }, base));
});
