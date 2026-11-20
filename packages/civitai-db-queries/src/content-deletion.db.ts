import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// The only DELETEs on "Image" and "Post" (guarded by `no-direct-image-post-delete.test.ts`).

/**
 * Who a delete is for: a session user (its `id` and `isModerator`, so one can be passed as is) or a
 * named system caller. A member who is not a moderator deletes only rows they own.
 */
export type DeleteActor = { id: number; isModerator?: boolean } | { system: string };

export type DeletedImageRow = {
  id: number;
  url: string;
  userId: number;
  postId: number | null;
  nsfwLevel: number;
  ingestion: string;
  needsReview: string | null;
  blockedFor: string | null;
  /** The video a custom thumbnail belongs to; null when absent or malformed. */
  parentId: number | null;
};

/** A deleted image, and whether its stored file goes with every version. */
export type DeletedImage = DeletedImageRow & { allVersions: boolean };

export type DeletedPostRow = { id: number; userId: number; nsfwLevel: number };

/** How a delete's stored files go: each condition is read against the deleted row's columns. */
export type ImageFiles = {
  /** Every version of the object goes, not only the current one. */
  allVersions?: RawBuilder<boolean>;
  /** An object that shop artwork still uses stays. */
  keepShopArtwork?: RawBuilder<boolean>;
};

/** Not under CSAM review or blocked for CSAM. Read against the image row, unqualified. */
const notCsamFlagged = sql<boolean>`"needsReview" IS DISTINCT FROM 'csam' AND "blockedFor" IS DISTINCT FROM 'CSAM'`;

/**
 * A moderator's delete purges every version of the stored object, except for an image under CSAM
 * review or blocked for CSAM, which goes by key alone.
 */
export const moderatorPurge = notCsamFlagged;

type DeleteOptions = {
  ids: number[];
  actor: DeleteActor;
  /**
   * The caller's own condition, written against the unaliased table. With one, the rows are locked
   * first and the DELETE re-checks it, but only on the row's own columns: a hold kept in another
   * table is read from the statement's snapshot.
   */
  where?: RawBuilder<boolean>;
};

function conditions({ actor, where }: DeleteOptions) {
  const own = 'id' in actor && !actor.isModerator ? sql`AND "userId" = ${actor.id}` : sql``;
  return sql`${own} ${where ? sql`AND (${where})` : sql``}`;
}

/** The DELETE itself. With a caller's condition, the rows are locked first and it is re-checked. */
function deleteStatement(table: 'Image' | 'Post', options: DeleteOptions, ids: number[]) {
  const t = sql.table(table);
  const on = conditions(options);
  // One array parameter, not one per id: an account wipe can list more ids than a statement binds.
  const listed = sql`id = ANY(${ids}::int[])`;
  return {
    lock: options.where
      ? sql`doomed AS (SELECT id FROM ${t} WHERE ${listed} ${on} ORDER BY id FOR UPDATE)`
      : sql``,
    remove: sql`DELETE FROM ${t} WHERE ${
      options.where ? sql`id IN (SELECT id FROM doomed)` : listed
    } ${on}`,
  };
}

// A queued all-versions purge of the same key stays one: a later key-only delete cannot downgrade it.
const STORAGE_DELETE_UPSERT = sql`
  ON CONFLICT ("entityType", "entityId", "type") DO UPDATE SET "data" = EXCLUDED."data"
    WHERE "JobQueue"."data"->>'url' IS DISTINCT FROM EXCLUDED."data"->>'url'
      OR (EXCLUDED."data"->>'allVersions' IS NOT NULL AND "JobQueue"."data"->>'allVersions' IS NULL)`;

// Re-dated by the clock, not the transaction's start: a recount run that read the row before this
// delete then leaves it for the next run.
const POST_RECOUNT_UPSERT = sql`
  ON CONFLICT ("entityType", "entityId", "type") DO UPDATE SET "createdAt" = clock_timestamp()`;

/**
 * Deletes image rows and, in the same statement, queues what can wait: each stored file for the main
 * app's `image-storage-deletes` job (unless `files` is absent, when the files stay); with
 * `recountPosts`, each post's rating recount for `update-nsfw-levels`; and with `cdnTakedown`, a
 * moderator's takedown of each url for `cdn-access-sync`. So a deleted row always leaves its
 * follow-ups queued, with no transaction around it.
 */
export async function deleteImageRows(
  db: Kysely<DB>,
  options: DeleteOptions & { files?: ImageFiles; recountPosts?: boolean; cdnTakedown?: boolean }
): Promise<DeletedImage[]> {
  const ids = [...new Set(options.ids)];
  if (!ids.length) return [];
  const { lock, remove } = deleteStatement('Image', options, ids);
  const { files, recountPosts = false, cdnTakedown = false } = options;
  const { rows } = await sql<DeletedImage>`
    WITH ${options.where ? sql`${lock},` : sql``}
    gone AS (
      ${remove}
      RETURNING id, url, "userId", "postId", "nsfwLevel", ingestion, "needsReview", "blockedFor",
        CASE WHEN metadata->>'parentId' ~ '^[0-9]{1,10}$' THEN
          CASE WHEN (metadata->>'parentId')::bigint <= 2147483647 THEN (metadata->>'parentId')::int END
        END AS "parentId"
    ),
    deleted AS (
      SELECT gone.*,
        COALESCE(${files?.allVersions ?? sql`false`}, false) AS "allVersions",
        COALESCE(${files?.keepShopArtwork ?? sql`false`}, false) AS "keepShopArtwork"
      FROM gone
    ),
    files AS (
      INSERT INTO "JobQueue" ("entityId", "entityType", "type", "data")
      SELECT id, 'Image'::"EntityType", 'ImageStorageDelete'::"JobQueueType",
        jsonb_strip_nulls(jsonb_build_object(
          'url', url,
          'allVersions', NULLIF("allVersions", false),
          'keepShopArtwork', NULLIF("keepShopArtwork", false)
        ))
      FROM deleted WHERE ${!!files}
      ${STORAGE_DELETE_UPSERT}
    ),
    posts AS (
      INSERT INTO "JobQueue" ("entityId", "entityType", "type")
      SELECT DISTINCT "postId", 'Post'::"EntityType", 'UpdateNsfwLevel'::"JobQueueType"
      FROM deleted WHERE "postId" IS NOT NULL AND ${recountPosts}
      -- In id order, so two deletes upserting the same posts cannot lock them in opposite orders.
      ORDER BY "postId"
      ${POST_RECOUNT_UPSERT}
    ),
    cdn AS (
      -- As queue_cdn_access_sync writes it. The row is gone by the time the job runs, so the url
      -- and owner travel in the payload.
      INSERT INTO "JobQueue" ("entityId", "entityType", "type", "data")
      SELECT id, 'Image'::"EntityType", 'CdnAccessSync'::"JobQueueType",
        jsonb_build_object('url', url, 'userId', "userId",
          'csamReview', "needsReview" IS NOT DISTINCT FROM 'csam', 'moderatorDelete', true,
          'seq', clock_timestamp())
      FROM deleted WHERE url IS NOT NULL AND ${cdnTakedown}
      ON CONFLICT ("entityType", "entityId", "type") DO UPDATE
        SET "data" = COALESCE("JobQueue"."data", '{}'::jsonb) || EXCLUDED."data"
    )
    SELECT id, url, "userId", "postId", "nsfwLevel", ingestion::text AS ingestion, "needsReview",
      "blockedFor", "parentId", "allVersions"
    FROM deleted`.execute(db);
  return rows;
}

export async function deletePostRows(db: Kysely<DB>, options: DeleteOptions) {
  const ids = [...new Set(options.ids)];
  if (!ids.length) return [];
  const { lock, remove } = deleteStatement('Post', options, ids);
  const { rows } = await sql<DeletedPostRow>`
    ${options.where ? sql`WITH ${lock}` : sql``}
    ${remove} RETURNING id, "userId", "nsfwLevel"`.execute(db);
  return rows;
}

/** Queues a deleted image's stored file again, as when a delete made outside the queue fails. */
export async function queueImageStorageDelete(
  db: Kysely<DB>,
  { id, url, allVersions = false }: { id: number; url: string; allVersions?: boolean }
) {
  await sql`
    INSERT INTO "JobQueue" ("entityId", "entityType", "type", "data")
    VALUES (${id}, 'Image'::"EntityType", 'ImageStorageDelete'::"JobQueueType",
      ${JSON.stringify({ url, ...(allVersions && { allVersions: true }) })}::jsonb)
    ${STORAGE_DELETE_UPSERT}
  `.execute(db);
}

/**
 * Every place an image is shown or used, by the name `Image` gives the relation in the Prisma schema:
 * the table and the column holding the image's id. Most of them null out on delete, so a missed one
 * silently blanks that surface. The main app's schema test fails on an `Image` relation left out.
 */
export const IMAGE_USES = {
  assignedUser: ['User', 'profilePictureId'],
  connections: ['ImageConnection', 'imageId'],
  collectionItems: ['CollectionItem', 'imageId'],
  collections: ['Collection', 'imageId'],
  UserProfile: ['UserProfile', 'coverImageId'],
  userProfileSfwCover: ['UserProfile', 'sfwCoverImageId'],
  announcementCovers: ['Announcement', 'coverId'],
  clubCover: ['Club', 'coverImageId'],
  clubHeader: ['Club', 'headerImageId'],
  clubAvatar: ['Club', 'avatarId'],
  clubTierCover: ['ClubTier', 'coverImageId'],
  clubPostCoverImage: ['ClubPost', 'coverImageId'],
  article: ['Article', 'coverId'],
  articleBanner: ['Article', 'bannerId'],
  purchasableRewards: ['PurchasableReward', 'coverImageId'],
  CosmeticShopSection: ['CosmeticShopSection', 'imageId'],
  comicPanels: ['ComicPanel', 'imageId'],
  comicReferenceImages: ['ComicReferenceImage', 'imageId'],
  comicProjectCover: ['ComicProject', 'coverImageId'],
  comicProjectHero: ['ComicProject', 'heroImageId'],
  challengesCover: ['Challenge', 'coverImageId'],
  challengeWins: ['ChallengeWinner', 'imageId'],
  challengeEventCovers: ['ChallengeEvent', 'coverImageId'],
  model3dThumbnails: ['Model3D', 'thumbnailImageId'],
  model3dSources: ['Model3D', 'sourceImageId'],
  appListingIcons: ['app_listings', 'icon_id'],
  appListingCovers: ['app_listings', 'cover_id'],
  appListingScreenshots: ['app_listing_screenshots', 'image_id'],
  appSubListingImages: ['app_sub_listings', 'image_id'],
  appSubListingPendingImages: ['app_sub_listings', 'pending_image_id'],
  crucibles: ['Crucible', 'imageId'],
  crucibleHeroes: ['Crucible', 'heroImageId'],
  crucibleEntries: ['CrucibleEntry', 'imageId'],
  serviceOfferingCovers: ['ServiceOffering', 'coverImageId'],
  serviceDealReviewImage: ['ServiceDealReviewImage', 'imageId'],
  storylineCovers: ['Storyline', 'coverImageId'],
  storylineHeroes: ['Storyline', 'heroImageId'],
  storylineSparks: ['Storyline', 'sparkImageId'],
  storylineCoverUploads: ['StorylineCoverUpload', 'imageId'],
} as const satisfies Record<string, readonly [string, string]>;

/**
 * The key a stored url names, lowercased; shop artwork columns hold whatever the client sent.
 * 🔴 Must match the expression indexes in migration `20261211120000_shop_artwork_key_indexes`
 * exactly, or every image create scans the shop artwork tables.
 */
export const storedKeySql = (column: string) =>
  `substring(replace(translate(lower(${column}), E'\\t\\r\\n', ''), '%2d', '-') from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')`;

const key = (column: string) => sql.raw(storedKeySql(column));

/** `NsfwLevel.Blocked`. */
const NSFW_LEVEL_BLOCKED = 32;

/** Not reported, awaiting review or blocked: moderation decides what happens to those. */
const notUnderModeration = sql`"Image"."needsReview" IS NULL
    AND "Image"."blockedFor" IS NULL
    AND "Image".ingestion <> 'Blocked'
    AND "Image"."nsfwLevel" <> ${NSFW_LEVEL_BLOCKED}
    AND NOT EXISTS (SELECT 1 FROM "ImageReport" r WHERE r."imageId" = "Image".id)`;

/**
 * Not under CSAM review, blocked for CSAM, reported for CSAM or listed in a `CsamReport`, which
 * lists an image as `{"id": n}`, `n` or `"n"`.
 */
const notCsamReported = sql`${notCsamFlagged}
    AND NOT EXISTS (
      SELECT 1 FROM "ImageReport" ir JOIN "Report" r ON r.id = ir."reportId"
      WHERE ir."imageId" = "Image".id AND r.reason = 'CSAM'
    )
    AND "Image".id::text NOT IN (
      SELECT CASE jsonb_typeof(e) WHEN 'object' THEN e->>'id' ELSE e#>>'{}' END
      FROM "CsamReport" c,
        jsonb_array_elements(CASE jsonb_typeof(c.images) WHEN 'array' THEN c.images ELSE '[]' END) e
      WHERE CASE jsonb_typeof(e) WHEN 'object' THEN e->>'id' ELSE e#>>'{}' END IS NOT NULL
    )`;

/**
 * An image a parent's delete may take with it, read against the unaliased "Image": `ownerId`'s own
 * (when given), in no post, used nowhere in `IMAGE_USES` and its stored object not shop artwork. An
 * owner's delete also leaves any image under moderation; a moderator's leaves only those reported for
 * CSAM. Checked when the delete is queued, and again by the delete itself.
 */
export function unusedImage({
  ownerId,
  moderatorDelete,
}: {
  ownerId?: number;
  moderatorDelete: boolean;
}) {
  const id = sql.ref('Image.id');
  const uses = Object.values(IMAGE_USES).map(
    ([table, column]) =>
      sql`NOT EXISTS (SELECT 1 FROM ${sql.table(table)} u WHERE u.${sql.id(column)} = ${id})`
  );
  // A stored "Image".url is the bare key, so its first key is the one.
  const imageKey = key('"Image".url');
  const owner = ownerId === undefined ? sql`` : sql`"Image"."userId" = ${ownerId} AND`;
  return sql<boolean>`${owner} "Image"."postId" IS NULL
    AND ${moderatorDelete ? notCsamReported : notUnderModeration}
    AND ${sql.join(uses, sql` AND `)}
    AND NOT EXISTS (
      SELECT 1 FROM "Cosmetic" c WHERE ${key(`c."data"->>'url'`)} = ${imageKey}
        AND EXISTS (SELECT 1 FROM "CosmeticShopItem" s WHERE s."cosmeticId" = c.id)
    )
    AND NOT EXISTS (SELECT 1 FROM "CosmeticShopItem" s WHERE ${key(
      `s."meta"->>'coverUrl'`
    )} = ${imageKey})
    AND NOT EXISTS (SELECT 1 FROM "ItemDefinition" d WHERE ${key(`d."imageUrl"`)} = ${imageKey})
    -- A taken-down listing's art, after the listing is gone: a label still points at it.
    AND NOT EXISTS (SELECT 1 FROM "ImageCdnShopTakedown" t WHERE t.url = ${imageKey})`;
}

/**
 * Of `imageIds`, records the ones `ownerId`'s parent no longer needs (`unusedImage`) for deletion, in
 * the transaction that unlinks them: the main app's `image-deletes` job deletes those still unused.
 */
export async function queueImageDeletes(
  db: Kysely<DB>,
  imageIds: number[],
  { ownerId, moderatorDelete = false }: { ownerId: number; moderatorDelete?: boolean }
) {
  const ids = [...new Set(imageIds)];
  if (!ids.length) return;
  await sql`
    INSERT INTO "JobQueue" ("entityId", "entityType", "type", "data")
    SELECT id, 'Image'::"EntityType", 'ImageDelete'::"JobQueueType",
      ${JSON.stringify(moderatorDelete ? { moderatorDelete: true } : {})}::jsonb
    FROM "Image"
    WHERE id = ANY(${ids}::int[]) AND ${unusedImage({ ownerId, moderatorDelete })}
    -- In id order, so two deletes upserting the same rows cannot lock them in opposite orders.
    ORDER BY id
    -- A moderator's flag is added to a row already queued, never taken off it.
    ON CONFLICT ("entityType", "entityId", "type") DO UPDATE SET "data" = EXCLUDED."data"
      WHERE EXCLUDED."data"->>'moderatorDelete' IS NOT NULL
        AND "JobQueue"."data"->>'moderatorDelete' IS NULL
  `.execute(db);
}

export async function dequeueImageDeletes(db: Kysely<DB>, imageIds: number[]) {
  const ids = [...new Set(imageIds)];
  if (!ids.length) return;
  await sql`
    DELETE FROM "JobQueue"
    WHERE type = 'ImageDelete' AND "entityType" = 'Image' AND "entityId" = ANY(${ids}::int[])
  `.execute(db);
}

/** Queues posts for the main app's `update-nsfw-levels` job, which recounts their rating. */
export async function queuePostNsfwLevelUpdates(db: Kysely<DB>, postIds: number[]) {
  // Sorted for the same reason as the delete's own recount.
  const ids = [...new Set(postIds)].sort((x, y) => x - y);
  if (!ids.length) return;
  await sql`
    INSERT INTO "JobQueue" ("entityId", "entityType", "type")
    SELECT unnest(${ids}::int[]), 'Post'::"EntityType", 'UpdateNsfwLevel'::"JobQueueType"
    ${POST_RECOUNT_UPSERT}
  `.execute(db);
}
