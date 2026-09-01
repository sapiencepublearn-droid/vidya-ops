-- Up Migration
-- =====================================================================
-- Free hosting has no persistent disk: the filesystem is wiped on every
-- restart and deploy, which would silently delete every uploaded bill.
-- Storing the bytes in Postgres keeps them, and means they are included
-- in the same backup as everything else.
--
-- This is a deliberate trade for the trial, not a long-term answer.
-- Bills are a few hundred KB each; at roughly 300 files a month the free
-- 0.5 GB database fills in well under a year. Move to object storage
-- (Cloudflare R2 or Supabase, both with free tiers) before then by
-- setting STORAGE_DRIVER=s3 and migrating these rows out.
-- =====================================================================

CREATE TABLE file_blobs (
    storage_key text PRIMARY KEY,
    bytes       bytea NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Attachments carry the metadata; this table carries only the content.
COMMENT ON TABLE file_blobs IS
  'File contents for the db storage driver. Keyed by attachments.storage_key.';

GRANT SELECT, INSERT, DELETE ON file_blobs TO crm_app;

-- Down Migration
DROP TABLE IF EXISTS file_blobs;
