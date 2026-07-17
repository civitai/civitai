import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

type CollectionItemStatusValue = Selectable<DB['CollectionItem']>['status'];

// Browsing-level bit flags, inlined from the app's browsingLevel.constants (no `~/…` imports allowed here).
// NsfwLevel: PG=1, PG13=2, R=4, X=8, XXX=16, Blocked=32.
const SFW_BROWSING_LEVELS_FLAG = 3; // PG | PG13
const NSFW_BROWSING_LEVELS_FLAG = 60; // R | X | XXX | Blocked
const COLLECTION_NSFW_BUCKET = 28; // R | X | XXX

// Stamp the reviewer + status on a set of collection items in one statement. Guards the empty-array case
// (`in ()` is a Postgres syntax error). `updatedAt` is set explicitly (the source raw SQL set it too). The
// permission/score/nsfw validation and the contest follow-ups from the source stay with the caller.
export function updateCollectionItemsStatus(
  db: Kysely<DB>,
  input: {
    collectionId: number;
    collectionItemIds: number[];
    status: CollectionItemStatusValue;
    userId: number;
  }
) {
  if (!input.collectionItemIds.length) return Promise.resolve([]);
  const now = new Date();
  return db
    .updateTable('CollectionItem')
    .set({ reviewedById: input.userId, reviewedAt: now, updatedAt: now, status: input.status })
    .where('collectionId', '=', input.collectionId)
    .where('id', 'in', input.collectionItemIds)
    .execute();
}

// The DB write core of the source `setCollectionItemNsfwLevel`: mark the collection item's image scanned at the
// moderator-assigned level. `updatedAt` is auto-stamped by the @updatedAt plugin (Prisma's image.update set it).
// Ownership/type/permission validation and the search-index update stay with the caller.
export function setCollectionItemNsfwLevel(
  db: Kysely<DB>,
  input: { imageId: number; nsfwLevel: number }
) {
  return db
    .updateTable('Image')
    .set({
      nsfwLevel: input.nsfwLevel,
      scannedAt: new Date(),
      ingestion: 'Scanned',
    })
    .where('id', '=', input.imageId)
    .execute();
}

// Recompute the collection nsfwLevel bucket (SFW bit + NSFW bucket) from a forced level or its ACCEPTED items,
// and write it only where it changed. RETURNs the changed collection ids (the search-index update stays with
// the caller). Guards the empty-array case. Faithful port of the source raw CTE.
export async function updateCollectionsNsfwLevels(db: Kysely<DB>, collectionIds: number[]) {
  if (!collectionIds.length) return [];
  const result = await sql<{ id: number }>`
    WITH collections AS (
      SELECT
        c.id,
        (
          CASE
            WHEN (c.metadata->>'forcedBrowsingLevel') IS NOT NULL
              AND (c.metadata->>'forcedBrowsingLevel') ~ '^[0-9]+$' THEN
              (
                (CASE WHEN ((c.metadata->>'forcedBrowsingLevel')::int & ${SFW_BROWSING_LEVELS_FLAG}) != 0 THEN 1 ELSE 0 END)
                | (CASE WHEN ((c.metadata->>'forcedBrowsingLevel')::int & ${NSFW_BROWSING_LEVELS_FLAG}) != 0 THEN ${COLLECTION_NSFW_BUCKET} ELSE 0 END)
              )
            ELSE
              (
                (CASE WHEN EXISTS (
                  SELECT 1 FROM "CollectionItem" ci
                  LEFT JOIN "Image"   i ON i.id = ci."imageId"
                  LEFT JOIN "Post"    p ON p.id = ci."postId"    AND p."publishedAt" IS NOT NULL
                  LEFT JOIN "Model"   m ON m.id = ci."modelId"   AND m."status" = 'Published'
                  LEFT JOIN "Article" a ON a.id = ci."articleId" AND a."publishedAt" IS NOT NULL
                  WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED'
                    AND (COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel", 0) & ${SFW_BROWSING_LEVELS_FLAG}) != 0
                ) THEN 1 ELSE 0 END)
                | (CASE WHEN EXISTS (
                  SELECT 1 FROM "CollectionItem" ci
                  LEFT JOIN "Image"   i ON i.id = ci."imageId"
                  LEFT JOIN "Post"    p ON p.id = ci."postId"    AND p."publishedAt" IS NOT NULL
                  LEFT JOIN "Model"   m ON m.id = ci."modelId"   AND m."status" = 'Published'
                  LEFT JOIN "Article" a ON a.id = ci."articleId" AND a."publishedAt" IS NOT NULL
                  WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED'
                    AND (COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel", 0) & ${NSFW_BROWSING_LEVELS_FLAG}) != 0
                ) THEN ${COLLECTION_NSFW_BUCKET} ELSE 0 END)
              )
          END
        ) AS "nsfwLevel"
      FROM "Collection" c
      WHERE c."id" IN (${sql.join(collectionIds)})
        AND c."availability" = 'Public'
        AND c."read" IN ('Public', 'Unlisted')
    )
    UPDATE "Collection" c
    SET "nsfwLevel" = c2."nsfwLevel"
    FROM collections c2
    WHERE c.id = c2.id
      AND c."nsfwLevel" != c2."nsfwLevel"
    RETURNING c.id;
  `.execute(db);
  return result.rows;
}

export function deleteCollectionForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('Collection').where('userId', '=', userId).execute();
}
