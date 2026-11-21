import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { evidenceVerifiedText } from '@civitai/shared/held-url';
import { OWNER_HIDDEN_REVIEWS } from '@civitai/shared/owner-hidden-reviews';
import { CHILD_SAFETY_VIOLATIONS } from '@civitai/shared/post-text-report';

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
  /**
   * Listed rows `blocked` keeps are left and queued as a `PendingDelete` with `data`, in the same
   * statement: from one snapshot, each row it locks is either deleted (unless a hold marker's trigger
   * keeps it) or queued. Read against the unaliased table.
   */
  pending?: { blocked: RawBuilder<boolean>; data: PendingDelete };
};

function conditions({ actor, where }: DeleteOptions) {
  const own = 'id' in actor && !actor.isModerator ? sql`AND "userId" = ${actor.id}` : sql``;
  return sql`${own} ${where ? sql`AND (${where})` : sql``}`;
}

/**
 * The DELETE itself, and the CTEs it needs. With a caller's condition or `pending`, the rows are
 * locked first and the condition re-checked; `pending` queues the locked rows it keeps.
 */
function deleteStatement(table: 'Image' | 'Post', options: DeleteOptions, ids: number[]) {
  const t = sql.table(table);
  const on = conditions(options);
  // One array parameter, not one per id: an account wipe can list more ids than a statement binds.
  const listed = sql`id = ANY(${ids}::int[])`;
  const { where, pending } = options;
  if (!where && !pending) return { ctes: [], remove: sql`DELETE FROM ${t} WHERE ${listed} ${on}` };
  const ctes = [
    sql`doomed AS (
      SELECT id, ${pending?.blocked ?? sql`false`} AS blocked FROM ${t}
      WHERE ${listed} ${on} ORDER BY id FOR UPDATE
    )`,
  ];
  if (pending)
    ctes.push(sql`pending AS (
      INSERT INTO "JobQueue" ("entityId", "entityType", "type", "data")
      SELECT id, ${table}::"EntityType", 'PendingDelete'::"JobQueueType",
        ${JSON.stringify(pending.data)}::jsonb
      FROM doomed WHERE blocked ORDER BY id
      ${PENDING_DELETE_UPSERT}
    )`);
  return {
    ctes,
    remove: sql`DELETE FROM ${t} WHERE id IN (SELECT id FROM doomed WHERE NOT blocked) ${on}`,
  };
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

const pendingRank = (data: string) =>
  sql.raw(
    `CASE WHEN ${data} ? 'moderatorDelete' THEN 3 WHEN ${data} ? 'ownerId' THEN 2 ELSE 1 END`
  );

// A stronger kind replaces a queued one (a moderator's cleanup, the owner's own delete, an owner's
// cleanup, strongest first) and the row keeps its earlier due time. The owner's ask survives either
// way, as `ownerId` on a moderator's cleanup. Anything else changes nothing.
const PENDING_DELETE_UPSERT = sql`
  ON CONFLICT ("entityType", "entityId", "type") DO UPDATE
    SET "data" = CASE
        WHEN ${pendingRank('EXCLUDED."data"')} > ${pendingRank('"JobQueue"."data"')}
        THEN EXCLUDED."data" ELSE "JobQueue"."data" END
      || jsonb_strip_nulls(jsonb_build_object(
        'ownerId', COALESCE(EXCLUDED."data"->'ownerId', "JobQueue"."data"->'ownerId'))),
      "createdAt" = LEAST("JobQueue"."createdAt", EXCLUDED."createdAt")
    WHERE ${pendingRank('EXCLUDED."data"')} > ${pendingRank('"JobQueue"."data"')}
      OR (EXCLUDED."data" ? 'ownerId' AND NOT "JobQueue"."data" ? 'ownerId')`;

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
  const { ctes, remove } = deleteStatement('Image', options, ids);
  const { files, recountPosts = false, cdnTakedown = false } = options;
  const { rows } = await sql<DeletedImage>`
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
      "blockedFor", "parentId", "allVersions"
    FROM deleted`.execute(db);
  return rows;
}

export async function deletePostRows(db: Kysely<DB>, options: DeleteOptions) {
  const ids = [...new Set(options.ids)];
  if (!ids.length) return [];
  const { ctes, remove } = deleteStatement('Post', options, ids);
  const { rows } = await sql<DeletedPostRow>`
    ${withCtes(ctes, false)}
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

const openChildSafetyReport = (reportId: RawBuilder<unknown>) => sql<boolean>`EXISTS (
  SELECT 1 FROM "Report" cs_r
  WHERE cs_r.id = ${reportId}
    AND cs_r.status IN ('Pending', 'Processing')
    AND (cs_r.reason = 'CSAM' OR (cs_r.reason = 'TOSViolation'
      AND cs_r.details ->> 'violation' IN (${sql.join([...CHILD_SAFETY_VIOLATIONS])})))
)`;

const postReported = (postId: RawBuilder<unknown>) => sql<boolean>`EXISTS (
  SELECT 1 FROM "PostReport" cs_pr
  WHERE cs_pr."postId" = ${postId} AND ${openChildSafetyReport(sql.ref('cs_pr.reportId'))}
)`;

/**
 * The image's CyberTip is filed with verified evidence. A report lists an image as `{"id": n}` or a
 * bare id, number or text.
 */
const evidenceFiled = (id: RawBuilder<unknown>) => sql<boolean>`EXISTS (
  SELECT 1 FROM "CsamReport" cs_cr
  -- CASE, not AND, so the cheap images test runs first and "details" is only read on a match.
  WHERE CASE
    WHEN jsonb_typeof(cs_cr.images) = 'array' AND (
      cs_cr.images @> jsonb_build_array(jsonb_build_object('id', ${id}))
      OR cs_cr.images @> jsonb_build_array(jsonb_build_object('id', ${id}::text))
      OR cs_cr.images @> jsonb_build_array(${id})
      OR cs_cr.images @> jsonb_build_array(${id}::text)
    )
    THEN cs_cr."reportSentAt" IS NOT NULL AND ${sql.raw(evidenceVerifiedText('cs_cr'))}
    ELSE false
  END
)`;

// Each leg is a CASE so its subquery runs only on a row the leg can hold: an AND whose first test is
// NULL (no flag, the usual image) still evaluates its second.

/**
 * Blocked for CSAM, until its CyberTip is filed with verified evidence. Read against `image` (a
 * table name or alias). The broader "held" rule is `heldImageSql` in @civitai/shared/held-media.
 */
const csamBlockOpen = (image: string) => {
  const col = (name: string) => sql.ref(`${image}.${name}`);
  return sql<boolean>`CASE WHEN ${col('blockedFor')} = 'CSAM'
    THEN NOT ${evidenceFiled(col('id'))} ELSE false END`;
};

/** Under CSAM review, until the CSAM queue dismisses it; once blocked as CSAM, the block decides. */
const csamReviewOpen = (image: string) => {
  const col = (name: string) => sql.ref(`${image}.${name}`);
  return sql<boolean>`CASE WHEN ${col('needsReview')} = 'csam'
    AND ${col('blockedFor')} IS DISTINCT FROM 'CSAM'
    THEN NOT EXISTS (
      SELECT 1 FROM "CsamQueueSetAside" cs_s
      WHERE cs_s."imageId" = ${col('id')} AND cs_s.outcome = 'Dismissed'
    )
    ELSE false END`;
};

/**
 * A child-safety case its owner can already see, read against `image`: the image is served to them
 * as blocked. Only this case may tell the owner their delete waits on a review.
 */
export const childSafetyVisibleCase = (image = 'Image') => {
  const needsReview = sql.ref(`${image}.needsReview`);
  return sql<boolean>`(${csamBlockOpen(image)}
    AND COALESCE(${needsReview}, '') <> ALL(${sql.val([...OWNER_HIDDEN_REVIEWS])}::text[]))`;
};

/**
 * An image in an open child-safety case, read against `image`: under CSAM review, blocked for CSAM,
 * or under an open child-safety report on itself or its post. Its owner's delete waits for the case
 * to close.
 */
export const childSafetyImageCase = (image = 'Image') => {
  const col = (name: string) => sql.ref(`${image}.${name}`);
  return sql<boolean>`(
    ${csamReviewOpen(image)}
    OR ${csamBlockOpen(image)}
    OR EXISTS (
      SELECT 1 FROM "ImageReport" cs_ir
      WHERE cs_ir."imageId" = ${col('id')} AND ${openChildSafetyReport(sql.ref('cs_ir.reportId'))}
    )
    OR CASE WHEN ${col('postId')} IS NOT NULL THEN ${postReported(col('postId'))} ELSE false END
  )`;
};

/** A post under an open child-safety report, read against `post`; deleting it takes the report. */
export const childSafetyPostCase = (post = 'Post') => postReported(sql.ref(`${post}.id`));

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

/** Moderation still open on an image: a review other than CSAM, any block, or an open report. */
const moderationOpen = sql<boolean>`(
  ("Image"."needsReview" IS NOT NULL AND "Image"."needsReview" <> 'csam')
  OR "Image"."blockedFor" IS NOT NULL
  OR "Image".ingestion = 'Blocked'
  OR "Image"."nsfwLevel" = ${NSFW_LEVEL_BLOCKED}
  OR EXISTS (
    SELECT 1 FROM "ImageReport" pd_ir JOIN "Report" pd_r ON pd_r.id = pd_ir."reportId"
    WHERE pd_ir."imageId" = "Image".id AND pd_r.status IN ('Pending', 'Processing')
  )
)`;

/**
 * A delete that has to wait, one per entity in the `PendingDelete` queue: an owner's own delete a
 * child-safety case keeps, or a parent's cleanup of an image it no longer uses (a moderator's when
 * `moderatorDelete`). The main app's `pending-deletes` job carries it out once nothing blocks it.
 */
/** A moderator's cleanup carries `ownerId` when the owner also asked: it then goes though in use. */
export type PendingDelete =
  | { ownerId: number }
  | { cleanup: true; moderatorDelete?: true; ownerId?: number };

/** Every image id a CSAM report not yet sent lists, as text; a report lists `{"id": n}` or a bare id. */
const UNSENT_LISTED_IMAGE_IDS = sql`
  SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END
  FROM "CsamReport" ul
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(ul.images) = 'array' THEN ul.images ELSE '[]'::jsonb END
  ) le
  WHERE ul."reportSentAt" IS NULL`;

// Each set below is uncorrelated, so Postgres builds it once per statement. No NULL may enter one: a
// miss would then read NULL rather than false, and a NULL `blocked` row is neither deleted nor queued.

/**
 * A CSAM report not yet sent names `ownerId`, as its subject or its secondary user. The sender reads
 * that account and its content at send time, so all of it is held.
 */
const unsentReportNames = (ownerId: number | RawBuilder<unknown>) =>
  sql<boolean>`((${ownerId})::text IN (
    SELECT ur."userId"::text FROM "CsamReport" ur
    WHERE ur."reportSentAt" IS NULL AND ur."userId" IS NOT NULL
    UNION ALL
    SELECT us.details ->> 'secondaryUserId' FROM "CsamReport" us
    WHERE us."reportSentAt" IS NULL AND us.details ->> 'secondaryUserId' IS NOT NULL
  ))`;

/**
 * The image `imageId` is listed on a CSAM report not yet sent. Its owner may be named on none, so
 * only the image itself (and a post holding it) is held, not the rest of their content.
 */
const unsentReportLists = (imageId: RawBuilder<unknown>) =>
  sql<boolean>`((${imageId})::text IN (
    SELECT listed FROM (${UNSENT_LISTED_IMAGE_IDS}) AS u(listed) WHERE listed IS NOT NULL
  ))`;

/**
 * An owner's delete of their own image waits on its child-safety case, or on a CSAM report not yet
 * sent that names them or lists the image. Read against "Image".
 */
export const ownImageDeleteBlocked = (ownerId: number | RawBuilder<unknown>) =>
  sql<boolean>`("Image"."userId" = ${ownerId} AND (
    ${childSafetyImageCase()}
    OR ${unsentReportNames(ownerId)}
    OR ${unsentReportLists(sql.ref('Image.id'))}
  ))`;

/**
 * An owner's delete of their own post waits on a child-safety report on it, or on a CSAM report not
 * yet sent that names them or lists an image in it. Read against "Post".
 */
export const ownPostDeleteBlocked = (ownerId: number | RawBuilder<unknown>) =>
  sql<boolean>`("Post"."userId" = ${ownerId} AND (
    ${childSafetyPostCase()}
    OR ${unsentReportNames(ownerId)}
    OR EXISTS (
      SELECT 1 FROM "Image" pi
      WHERE pi."postId" = "Post".id AND ${unsentReportLists(sql.ref('pi.id'))}
    )
  ))`;

/**
 * What keeps a parent's cleanup of an image for now, read against "Image": its child-safety case, a
 * held owner (`heldOwner`, the caller's), and for an owner's cleanup any moderation still open,
 * which decides those images first.
 */
export const cleanupBlocked = (moderatorDelete: boolean, heldOwner: RawBuilder<boolean>) =>
  sql<boolean>`(${childSafetyImageCase()} OR ${heldOwner}${
    moderatorDelete ? sql`` : sql` OR ${moderationOpen}`
  })`;

/** What keeps the pending delete `data` (a queue row's) of an image, read against "Image". */
export const imageDeleteBlocked = (data: RawBuilder<unknown>, heldOwner: RawBuilder<boolean>) =>
  sql<boolean>`CASE
    WHEN ${data} ? 'moderatorDelete' THEN ${cleanupBlocked(true, heldOwner)}
    WHEN ${data} ? 'cleanup' THEN ${cleanupBlocked(false, heldOwner)}
    ELSE ${ownImageDeleteBlocked(sql`(${data}->>'ownerId')::int`)}
  END`;

/**
 * Of `imageIds`, those with a pending delete whose case their owner can see
 * (`childSafetyVisibleCase`): only those owners may be told their delete waits on a review.
 */
export async function imagesPendingDeletion(db: Kysely<DB>, imageIds: number[]) {
  const ids = [...new Set(imageIds)];
  if (!ids.length) return new Set<number>();
  const { rows } = await sql<{ id: number }>`
    SELECT id FROM "Image"
    WHERE id = ANY(${ids}::int[]) AND ${childSafetyVisibleCase()} AND EXISTS (
      SELECT 1 FROM "JobQueue" q
      WHERE q.type = 'PendingDelete' AND q."entityType" = 'Image' AND q."entityId" = "Image".id
    )
  `.execute(db);
  return new Set(rows.map((row) => row.id));
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

/**
 * Up to `limit` pending deletes of `entityType` due now, first attempts before retries, earliest due
 * first. A row is due from its `createdAt`, which a waiting row has moved to when it is next due.
 */
export async function readDueDeletes(db: Kysely<DB>, entityType: 'Image' | 'Post', limit: number) {
  const { rows } = await sql<{ id: number; data: PendingDelete; attempted: boolean }>`
    SELECT "entityId" AS id, data, COALESCE(data ? 'attempted', false) AS attempted
    FROM "JobQueue"
    WHERE type = 'PendingDelete' AND "entityType" = ${entityType}::"EntityType"
      AND "createdAt" <= now()
    ORDER BY COALESCE(data ? 'attempted', false), "createdAt"
    LIMIT ${limit}
  `.execute(db);
  return rows;
}

/**
 * Settles a run of pending deletes. `done` leave the queue: deleted, gone, or no longer wanted.
 * `waiting` are still blocked and come back later: their `createdAt` moves to then, so the overdue
 * check (`JOB_QUEUE_OVERDUE_MINUTES`) reads only a row the job has stopped reaching. `failed` threw,
 * and come back on the next run, after its first attempts.
 */
export async function settleDeletes(
  db: Kysely<DB>,
  entityType: 'Image' | 'Post',
  {
    done = [],
    waiting = [],
    failed = [],
  }: { done?: number[]; waiting?: number[]; failed?: number[] }
) {
  const of = (ids: number[]) => sql`type = 'PendingDelete'
    AND "entityType" = ${entityType}::"EntityType" AND "entityId" = ANY(${ids}::int[])`;
  if (done.length) await sql`DELETE FROM "JobQueue" WHERE ${of(done)}`.execute(db);
  // An owner's ask comes due just inside the job's 5-minute interval, so the next run takes it; a
  // cleanup waits on moderation, so hourly.
  if (waiting.length)
    await sql`
      UPDATE "JobQueue"
      SET "createdAt" = now() + CASE WHEN data ? 'cleanup' AND NOT data ? 'ownerId'
          THEN interval '1 hour' ELSE interval '4 minutes' END,
        data = data - 'attempted'
      WHERE ${of(waiting)}
    `.execute(db);
  if (failed.length)
    await sql`
      UPDATE "JobQueue" SET data = data || '{"attempted": true}'::jsonb WHERE ${of(failed)}
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
