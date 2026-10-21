-- 0025_drop_pgcrypto.sql  (EPOCH-477)
--
-- 0001 created the pgcrypto extension for gen_random_uuid(), which PostgreSQL
-- has built in since 13; nothing else used it. The Lab bundle's PostgreSQL is
-- built without OpenSSL, so it has no pgcrypto, and 0001 no longer asks for
-- it. This drops it where an earlier 0001 created it, so every database has
-- the same extensions.

DROP EXTENSION IF EXISTS pgcrypto;
