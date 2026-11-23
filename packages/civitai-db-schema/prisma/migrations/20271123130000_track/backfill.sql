-- Backfill for migration.sql: "Image".metadata.coverImageId and "Image".metadata.genre into "Track".
-- Run by hand, dry run first, right after migration.sql on any environment that holds song data.
-- Skip it on prod while prod holds no audio rows: no index covers type = 'audio', so the candidate
-- scan reads the whole "Image" table to find none.
--
-- Rules (from the code's own definitions, post.service.ts):
--  * one row per audio "Image" whose metadata names a qualifying cover or a valid genre;
--  * coverImageId only when the referenced row passes isCoverOfSong (same owner, in no post,
--    metadata.parentId = the song's id) and is not already another song's Track cover;
--  * genre only when it is one of SONG_GENRES (src/shared/constants/song-genres.ts).
-- Idempotent: a second run changes nothing, and a value the new code already wrote is never
-- replaced (COALESCE keeps the existing Track value). The "Image".metadata keys are left in place.
SET lock_timeout = '3s';
SET statement_timeout = '10min';

WITH songs AS (
  SELECT s.id, s."userId", s.metadata
  FROM "Image" s
  WHERE s.type = 'audio' AND (s.metadata ? 'coverImageId' OR s.metadata ? 'genre')
), source AS (
  SELECT
    s.id AS "imageId",
    (
      SELECT c.id FROM "Image" c
      WHERE jsonb_typeof(s.metadata -> 'coverImageId') = 'number'
        AND c.id = (s.metadata ->> 'coverImageId')::numeric::int
        AND c."userId" = s."userId"
        AND c."postId" IS NULL
        AND c.metadata -> 'parentId' = to_jsonb(s.id)
        AND NOT EXISTS (
          SELECT 1 FROM "Track" t WHERE t."coverImageId" = c.id AND t."imageId" <> s.id
        )
    ) AS "coverImageId",
    CASE WHEN s.metadata ->> 'genre' IN (
      'Pop', 'Rock', 'Hip-Hop', 'R&B', 'Electronic', 'Dance', 'House', 'Techno', 'Synthwave',
      'Lo-fi', 'Ambient', 'Jazz', 'Blues', 'Classical', 'Country', 'Folk', 'Metal', 'Punk',
      'Reggae', 'Latin', 'K-Pop', 'Soundtrack', 'Other'
    ) THEN s.metadata ->> 'genre' END AS genre
  FROM songs s
)
INSERT INTO "Track" ("imageId", "coverImageId", genre)
SELECT "imageId", "coverImageId", genre FROM source
WHERE "coverImageId" IS NOT NULL OR genre IS NOT NULL
ON CONFLICT ("imageId") DO UPDATE SET
  "coverImageId" = COALESCE("Track"."coverImageId", EXCLUDED."coverImageId"),
  genre = COALESCE("Track".genre, EXCLUDED.genre);

-- Post-apply checks (read-only), each expected to return 0 where the new code wrote no Track row
-- first; otherwise each also counts songs whose Track value the new code set to something else:
-- SELECT count(*) FROM "Image" i
--   WHERE i.type = 'audio' AND i.metadata ->> 'genre' IN (<the SONG_GENRES list>)
--     AND NOT EXISTS (SELECT 1 FROM "Track" t WHERE t."imageId" = i.id AND t.genre = i.metadata ->> 'genre');
-- SELECT count(*) FROM "Image" s JOIN "Image" c
--     ON jsonb_typeof(s.metadata -> 'coverImageId') = 'number'
--    AND c.id = (s.metadata ->> 'coverImageId')::numeric::int
--   WHERE s.type = 'audio' AND c."userId" = s."userId" AND c."postId" IS NULL
--     AND c.metadata -> 'parentId' = to_jsonb(s.id)
--     AND NOT EXISTS (SELECT 1 FROM "Track" t WHERE t."imageId" = s.id AND t."coverImageId" = c.id);
