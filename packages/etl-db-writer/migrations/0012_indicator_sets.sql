-- 0012_indicator_sets.sql  (EPOCH-490)
--
-- Indicator sets as data: the registry the indicator-match stage (EPOCH-491)
-- reads. A set is a list of STIX 2.1 files; its identity is the SHA-256 of its
-- canonical manifest (packages/contracts/python/indicator_set.py).
--
--   D2  Append-only tables, with each file's raw bytes stored by SHA-256 in
--       the same transaction as the set, so a set is registered whole or not
--       at all, and any machine with the database can re-check it.
--
-- Nothing here is ever updated or deleted: a newer set is a new row beside
-- the old one, as a newer parser version is for facts (R8). The triggers make
-- that hold in the database; the writer has no update or delete path either.

-- Each STIX file's bytes, once, keyed by their SHA-256. Two sets that share a
-- file share its row. The checks hold the key to the bytes.
CREATE TABLE indicator_file_contents (
    sha256      TEXT PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    content     BYTEA NOT NULL,
    byte_count  BIGINT NOT NULL CHECK (byte_count = octet_length(content)),
    stored_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (encode(sha256(content), 'hex') = sha256)
);

-- One row per distinct set. `manifest` is the exact canonical text whose
-- SHA-256 is `set_hash`, checked here.
CREATE TABLE indicator_sets (
    set_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    set_hash         TEXT NOT NULL UNIQUE CHECK (set_hash ~ '^[0-9a-f]{64}$'),
    manifest         TEXT NOT NULL,
    -- When the loader read the files: an indicator's `expired` is relative to it.
    loaded_at        TIMESTAMPTZ NOT NULL,
    registered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    indicator_count  INTEGER NOT NULL CHECK (indicator_count >= 0),
    CHECK (encode(sha256(convert_to(manifest, 'UTF8')), 'hex') = set_hash)
);

-- A set's files, with their provenance and what the loader made of each
-- (the counts by type and by unsupported reason, FileReport).
CREATE TABLE indicator_set_files (
    set_id             UUID NOT NULL REFERENCES indicator_sets (set_id),
    path               TEXT NOT NULL,
    sha256             TEXT NOT NULL REFERENCES indicator_file_contents (sha256),
    source_repository  TEXT,
    source_commit      TEXT CHECK (source_commit ~ '^[0-9a-f]{40}$'),
    licence            TEXT NOT NULL,
    -- D7: false for an unknown licence and any licence not cleared for redistribution.
    redistributable    BOOLEAN NOT NULL,
    downloaded_on      DATE,
    report             JSONB NOT NULL,
    PRIMARY KEY (set_id, path)
);

-- One row per value an indicator object tests for.
CREATE TABLE indicators (
    indicator_id      BIGSERIAL PRIMARY KEY,
    set_id            UUID NOT NULL,
    file_path         TEXT NOT NULL,
    stix_id           TEXT NOT NULL,
    stix_path         TEXT NOT NULL,
    indicator_type    TEXT NOT NULL,
    value             TEXT NOT NULL,
    normalized_value  TEXT NOT NULL,
    campaigns         TEXT[] NOT NULL,
    valid_from        TIMESTAMPTZ,
    valid_until       TIMESTAMPTZ,
    expired           BOOLEAN NOT NULL,
    FOREIGN KEY (set_id, file_path) REFERENCES indicator_set_files (set_id, path),
    UNIQUE (set_id, file_path, stix_id, stix_path, normalized_value)
);

CREATE FUNCTION indicator_registry_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only (EPOCH-490): % is not allowed', TG_TABLE_NAME, TG_OP;
END
$$;

CREATE TRIGGER indicator_file_contents_immutable BEFORE UPDATE OR DELETE ON indicator_file_contents
    FOR EACH ROW EXECUTE FUNCTION indicator_registry_reject_change();
CREATE TRIGGER indicator_sets_immutable BEFORE UPDATE OR DELETE ON indicator_sets
    FOR EACH ROW EXECUTE FUNCTION indicator_registry_reject_change();
CREATE TRIGGER indicator_set_files_immutable BEFORE UPDATE OR DELETE ON indicator_set_files
    FOR EACH ROW EXECUTE FUNCTION indicator_registry_reject_change();
CREATE TRIGGER indicators_immutable BEFORE UPDATE OR DELETE ON indicators
    FOR EACH ROW EXECUTE FUNCTION indicator_registry_reject_change();

-- The matcher's lookup: one set's values of one type. Created last, so
-- migrate.py can tell this migration finished.
CREATE INDEX idx_indicators_lookup ON indicators (set_id, indicator_type, normalized_value);
