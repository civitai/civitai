-- Feeds that list songs (`image.getInfinite` with types=[audio], the /music "All music" feed) filter
-- "Image" by type. Songs are a tiny share of the table and the only per-type index is the video one,
-- so without this the planner seq-scans "Image" and the feed hits the statement timeout.
--
-- Hand-applied, outside a transaction (CONCURRENTLY). A build that fails leaves an INVALID index:
-- drop it with DROP INDEX CONCURRENTLY and run this again.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Image_audio_id_idx" ON "Image" (id) WHERE type = 'audio';
