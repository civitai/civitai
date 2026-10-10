import { sql } from 'kysely';

/**
 * Which of `imageIds` the relabel set must never contain, because a CSAM report or CSAM block
 * touches the image or its owner. Run against the main database, at build time and again each time
 * an item is served, since a report can arrive after the item was sampled.
 *
 * Every signal is used, because none is complete on its own: a user's CSAM report blocks the
 * image with `blockedFor = 'CSAM'` but files no `CsamReport` until a moderator sends one; a later
 * moderator removal overwrites `blockedFor`; and an unsent `CsamReport` can have its image list
 * replaced. The owner checks are deliberately broader than the ticket's "CSAM-reported images".
 */
export const csamExcludedImageIds = (imageIds: number[]) => sql<{ id: number }>`
  WITH candidate AS (SELECT DISTINCT unnest(${imageIds}::int[]) AS id),
  reported AS (
    SELECT DISTINCT (CASE jsonb_typeof(e) WHEN 'object' THEN e->>'id' ELSE e#>>'{}' END) AS id
    FROM "CsamReport", jsonb_array_elements("images"::jsonb) e
  )
  SELECT c.id
  FROM candidate c
  LEFT JOIN "Image" i ON i.id = c.id
  WHERE c.id::text IN (SELECT id FROM reported)
     OR EXISTS (
       SELECT 1 FROM "ImageReport" ir JOIN "Report" r ON r.id = ir."reportId"
       WHERE ir."imageId" = c.id AND r.reason = 'CSAM'
     )
     OR EXISTS (SELECT 1 FROM "CsamReport" cr WHERE cr."userId" = i."userId")
     OR EXISTS (
       SELECT 1 FROM "UserReport" ur JOIN "Report" r ON r.id = ur."reportId"
       WHERE ur."userId" = i."userId" AND r.reason = 'CSAM'
     )
     -- Covers the image's own CSAM block too: it is one of its owner's images.
     OR EXISTS (
       SELECT 1 FROM "Image" o WHERE o."userId" = i."userId" AND o."blockedFor" = 'CSAM'
     )
`;
