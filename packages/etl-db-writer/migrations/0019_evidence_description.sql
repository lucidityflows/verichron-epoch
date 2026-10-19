-- 0019_evidence_description.sql  (EPOCH-555, EPOCH-407)
--
-- An investigation is one piece of evidence, and it is named by the device
-- model, the iOS version and the backup's date (project owner, 2026-10-18),
-- never by the device identifier. Registration reads all three from the
-- backup's Info.plist, which it already reads for the UDID:
--
--   product_type  "Product Type", the model identifier (iPhone17,5)
--   ios_version   "Product Version" (26.6.1)
--   backup_date   "Last Backup Date": when the backup began (measured on a
--                 real pull: two seconds after the pull started)
--
-- Evidence registered before this migration has none of them and is refused:
-- development data is disposable, so rebuild the database and analyze again.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM evidence_items) THEN
        RAISE EXCEPTION 'evidence_items holds evidence registered before EPOCH-555, without its model, iOS version '
            'or backup date. Rebuild the database, then prepare and analyze the evidence again';
    END IF;
END
$$;

ALTER TABLE evidence_items
    ADD COLUMN product_type TEXT NOT NULL CONSTRAINT evidence_items_product_type_present CHECK (btrim(product_type) <> ''),
    ADD COLUMN ios_version  TEXT NOT NULL CONSTRAINT evidence_items_ios_version_present CHECK (btrim(ios_version) <> ''),
    ADD COLUMN backup_date  TIMESTAMPTZ NOT NULL;
