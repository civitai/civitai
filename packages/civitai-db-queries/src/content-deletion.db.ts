import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  GRACE_PRIOR_BLOCKED_FOR_KEY,
  GRACE_PRIOR_INGESTION_KEY,
  GRACE_PRIOR_NEEDS_REVIEW_KEY,
} from '@civitai/shared/account-deletion-grace';
import { childSafetyImageCase, childSafetyPostCase } from './child-safety-case.db';
import {
  NSFW_LEVEL_BLOCKED,
  PENDING_DELETE_UPSERT,
  PENDING_DELETES_ACTOR,
  ownerReportHold,
  pendingRowData,
  type DeleteReplay,
  type PendingDelete,
} from './pending-deletes.db';

// The only DELETEs on "Image" and "Post" (guarded by `no-direct-image-post-delete.test.ts`). A row
// in an open child-safety case is kept and queued instead: docs/features/pending-deletes.md.

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
   * The caller's own condition, written against the unaliased table. The DELETE re-checks it, but
   * only on the row's own columns: a hold kept in another table is read from the statement's snapshot.
   */
  where?: RawBuilder<boolean>;
  /** How the `pending-deletes` job carries out a row this delete leaves for its child-safety case. */
  replay?: DeleteReplay;
  /**
   * False: a row its case keeps is left but not queued: for a caller that retries it from a queue of
   * its own (a takedown, whose retraction only its own run sends), or whose condition must still hold
   * when the row goes, since a queued delete is carried out without it.
   */
  queueKept?: boolean;
};

/** A moderator's delete that queues what it keeps: a moderator decided the image goes. */
const moderatorDecides = (options: DeleteOptions) =>
  !!options.replay?.moderatorDelete && options.queueKept !== false;

function conditions({ actor, where }: DeleteOptions) {
  const own = 'id' in actor && !actor.isModerator ? sql`AND "userId" = ${actor.id}` : sql``;
  return sql`${own} ${where ? sql`AND (${where})` : sql``}`;
}

/**
 * The DELETE itself, and the CTEs it needs. It locks its rows first: one in an open child-safety case
 * is left and, unless `queueKept` is false, queued as a `PendingDelete` in the same statement; a row the
 * caller's condition excludes is neither deleted nor queued.
 */
function deleteStatement(table: 'Image' | 'Post', options: DeleteOptions, ids: number[]) {
  const t = sql.table(table);
  const on = conditions(options);
  const { actor } = options;
  const caseOpen = table === 'Image' ? childSafetyImageCase() : childSafetyPostCase();
  const blocked =
    'id' in actor ? sql<boolean>`(${caseOpen} OR ${ownerReportHold(table, actor.id)})` : caseOpen;
  const ctes = [
    // One array parameter, not one per id: an account wipe can list more ids than a statement binds.
    sql`listed AS (SELECT unnest(${ids}::int[]) AS id)`,
    sql`doomed AS (
      SELECT id, ${blocked} AS blocked, ${pendingRowData(actor, options.replay)} AS pending
      FROM ${t}
      WHERE id IN (SELECT id FROM listed) ${on} ORDER BY id FOR UPDATE
    )`,
  ];
  // The job's own delete leaves a row already in the queue as it is (the upsert would add a system ask
  // to it), and queues one it reaches another way (an image still in a post it carries out).
  const jobOwn = 'system' in actor && actor.system === PENDING_DELETES_ACTOR.system;
  if (options.queueKept !== false)
    ctes.push(sql`pending AS (
      INSERT INTO "JobQueue" ("entityId", "entityType", "type", "data")
      SELECT id, ${table}::"EntityType", 'PendingDelete'::"JobQueueType", pending
      FROM doomed WHERE blocked ORDER BY id
      ${
        jobOwn
          ? sql`ON CONFLICT ("entityType", "entityId", "type") DO NOTHING`
          : PENDING_DELETE_UPSERT
      }
    )`);
  // Only a moderator's delete that queues what it keeps rewrites an already-blocked image, so a
  // takedown keeps its reason and a grace block stays restorable. Grace markers are dropped so a
  // restore cannot lift this block.
  const hides = table === 'Image';
  const skipBlocked = !moderatorDecides(options);
  if (hides)
    ctes.push(sql`hidden AS (
      UPDATE "Image" SET ingestion = 'Blocked', "nsfwLevel" = ${NSFW_LEVEL_BLOCKED},
        "blockedFor" = CASE WHEN "blockedFor" = 'CSAM' THEN "blockedFor" ELSE 'moderated' END,
        -- Out of every review queue but the CSAM one, so no queue's accept lifts the block; a pending
        -- appeal keeps its flag unless the image is CSAM-blocked (as keepPendingAppealFlags does).
        "needsReview" = CASE WHEN "needsReview" = 'csam' THEN "needsReview"
          WHEN "blockedFor" IS DISTINCT FROM 'CSAM' AND EXISTS (SELECT 1 FROM "Appeal" a WHERE a."entityType" = 'Image'
            AND a."entityId" = "Image".id AND a.status = 'Pending') THEN 'appeal' END,
        metadata = CASE WHEN jsonb_typeof(metadata) = 'object'
          THEN metadata - ${GRACE_PRIOR_INGESTION_KEY}::text - ${GRACE_PRIOR_BLOCKED_FOR_KEY}::text
            - ${GRACE_PRIOR_NEEDS_REVIEW_KEY}::text - 'ruleId' - 'ruleReason'
          ELSE metadata END,
        "updatedAt" = now()
      WHERE id IN (SELECT id FROM doomed WHERE blocked)
        ${skipBlocked ? sql`AND ingestion IS DISTINCT FROM 'Blocked'` : sql``}
      RETURNING id, "userId", "postId"
    )`);
  // A post its delete keeps leaves the site as a moderator's unpublish takes it off
  // (`unpublishPostAsModerator`), with its own reason, so it stays visible to its owner and moderators.
  const hidesPost = table === 'Post';
  if (hidesPost)
    ctes.push(sql`hidden AS (
      UPDATE "Post" SET
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'unpublishedAt', ${new Date().toISOString()}::text,
          'unpublishedBy', ${'id' in actor ? actor.id : -1}::int,
          'unpublishedReason', ${POST_PENDING_DELETE_REASON}::text,
          'prevPublishedAt', COALESCE(metadata -> 'prevPublishedAt', to_jsonb("publishedAt"))
        ),
        "publishedAt" = NULL
      -- A post a moderator already unpublished keeps its own reason.
      WHERE id IN (SELECT id FROM doomed WHERE blocked)
        AND ("publishedAt" IS NOT NULL OR metadata ->> 'unpublishedReason' IS NULL)
      RETURNING id, "userId"
    )`);
  return {
    ctes,
    remove: sql`DELETE FROM ${t} WHERE id IN (SELECT id FROM doomed WHERE NOT blocked) ${on}`,
    // The rest of each listed id's outcome, as rows to append to the deleted ones: kept for its case,
    // or gone before the statement (its snapshot still sees the rows it deletes).
    others: (padding: RawBuilder<unknown>) => sql`
      SELECT id, ${padding}, 'kept' AS outcome FROM doomed WHERE blocked
      UNION ALL
      SELECT id, ${padding}, 'gone' FROM listed
      WHERE NOT EXISTS (SELECT 1 FROM ${t} WHERE ${t}.id = listed.id)`,
    hides,
    hidesPost,
  };
}

/** Why a post its delete keeps is unpublished; publishing it again is refused while it is set. */
export const POST_PENDING_DELETE_REASON = 'pending-delete';

/** A kept image a moderator's delete blocked, and the post it is still in. */
export type HiddenImage = { id: number; userId: number; postId: number | null };

/**
 * What a delete did with each listed id it did not delete: kept for its child-safety case, or already
 * gone. A row the caller's condition or ownership skipped is in neither. `hidden` is the kept images
 * a moderator's delete blocked.
 */
export type DeleteOutcome<Row> = {
  deleted: Row[];
  kept: number[];
  hidden: HiddenImage[];
  gone: number[];
};

/** A deleted row carries no `outcome`; a kept, hidden or gone one says which. */
type OutcomeRow = { id: number; outcome?: 'kept' | 'hidden' | 'gone' };

function splitOutcome<Row>(rows: (Row & OutcomeRow)[]): DeleteOutcome<Row> {
  const deleted: Row[] = [];
  const kept: number[] = [];
  const hidden: HiddenImage[] = [];
  const gone: number[] = [];
  for (const { outcome, ...row } of rows) {
    if (outcome === 'kept') kept.push(row.id);
    else if (outcome === 'hidden') {
      const { userId, postId } = row as unknown as HiddenImage;
      hidden.push({ id: row.id, userId, postId });
    } else if (outcome === 'gone') gone.push(row.id);
    else deleted.push(row as unknown as Row);
  }
  return { deleted, kept, hidden, gone };
}

const withCtes = (ctes: RawBuilder<unknown>[], more: boolean) =>
  ctes.length ? sql`WITH ${sql.join(ctes)}${more ? sql`,` : sql``}` : more ? sql`WITH` : sql``;

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
 * follow-ups queued, with no transaction around it. A delete that hides an image no moderator decided
 * on runs a second statement, so run that one in a transaction. Returns what became of each listed id.
 */
export async function deleteImageRows(
  db: Kysely<DB>,
  options: DeleteOptions & { files?: ImageFiles; recountPosts?: boolean; cdnTakedown?: boolean }
): Promise<DeleteOutcome<DeletedImage>> {
  const ids = [...new Set(options.ids)];
  if (!ids.length) return { deleted: [], kept: [], hidden: [], gone: [] };
  const { ctes, remove, others, hides } = deleteStatement('Image', options, ids);
  const { files, recountPosts = false, cdnTakedown = false } = options;
  const { rows } = await sql<DeletedImage & OutcomeRow>`
    ${withCtes(ctes, true)}
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
      "blockedFor", "parentId", "allVersions", NULL AS outcome
    FROM deleted
    UNION ALL
    ${others(sql.raw('NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL'))}
    ${
      hides
        ? sql`UNION ALL
      SELECT id, NULL, "userId", "postId", NULL, NULL, NULL, NULL, NULL, NULL, 'hidden' FROM hidden`
        : sql``
    }`.execute(db);
  const outcome = splitOutcome(rows);
  // Blocking an image queues it for `remove-blocked-images` (trg_blocked_image_delete_queue), which
  // would delete it on a retention clock with no one having decided so. Unless a moderator did, the
  // queued delete owns it. A second statement: the trigger's row is not visible inside the first.
  if (outcome.hidden.length && !moderatorDecides(options))
    await sql`
      DELETE FROM "JobQueue"
      WHERE type = 'BlockedImageDelete' AND "entityType" = 'Image'
        AND "entityId" = ANY(${outcome.hidden.map(({ id }) => id)}::int[])
    `.execute(db);
  return outcome;
}

/** Deletes post rows; returns what became of each listed id. */
export async function deletePostRows(
  db: Kysely<DB>,
  options: DeleteOptions
): Promise<DeleteOutcome<DeletedPostRow>> {
  const ids = [...new Set(options.ids)];
  if (!ids.length) return { deleted: [], kept: [], hidden: [], gone: [] };
  const { ctes, remove, others, hidesPost } = deleteStatement('Post', options, ids);
  const { rows } = await sql<DeletedPostRow & OutcomeRow>`
    ${withCtes(ctes, true)}
    gone_rows AS (${remove} RETURNING id, "userId", "nsfwLevel")
    SELECT id, "userId", "nsfwLevel", NULL AS outcome FROM gone_rows
    UNION ALL
    ${others(sql.raw('NULL, NULL'))}
    ${hidesPost ? sql`UNION ALL SELECT id, "userId", NULL, 'hidden' FROM hidden` : sql``}`.execute(
    db
  );
  return splitOutcome(rows);
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

/** In no post, used nowhere in `IMAGE_USES` and its stored object not shop artwork. */
export function imageNotUsed() {
  const id = sql.ref('Image.id');
  const uses = Object.values(IMAGE_USES).map(
    ([table, column]) =>
      sql`NOT EXISTS (SELECT 1 FROM ${sql.table(table)} u WHERE u.${sql.id(column)} = ${id})`
  );
  // A stored "Image".url is the bare key, so its first key is the one.
  const imageKey = key('"Image".url');
  return sql<boolean>`"Image"."postId" IS NULL
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
 * Of `imageIds`, records `ownerId`'s own that the parent no longer needs (`imageNotUsed`) as
 * pending cleanups.
 */
export async function queueImageDeletes(
  db: Kysely<DB>,
  imageIds: number[],
  { ownerId, moderatorDelete = false }: { ownerId: number; moderatorDelete?: boolean }
) {
  const ids = [...new Set(imageIds)];
  if (!ids.length) return;
  const data: PendingDelete = { cleanup: true, ...(moderatorDelete && { moderatorDelete: true }) };
  await sql`
    INSERT INTO "JobQueue" ("entityId", "entityType", "type", "data")
    SELECT id, 'Image'::"EntityType", 'PendingDelete'::"JobQueueType", ${JSON.stringify(
      data
    )}::jsonb
    FROM "Image"
    WHERE id = ANY(${ids}::int[]) AND "userId" = ${ownerId} AND ${imageNotUsed()}
    -- In id order, so two deletes upserting the same rows cannot lock them in opposite orders.
    ORDER BY id
    ${PENDING_DELETE_UPSERT}
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
