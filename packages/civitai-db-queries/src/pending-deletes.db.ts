import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  childSafetyImageCase,
  childSafetyPostCase,
  childSafetyVisibleCase,
} from './child-safety-case.db';
import type { DeleteActor } from './content-deletion.db';
import {
  csamReportListedImageIdsSql,
  csamReportNamedUserIdsSql,
  type CsamReportFilter,
} from '@civitai/shared/held-media';

// The `PendingDelete` queue: a delete a child-safety case keeps, or a parent's cleanup, until the main
// app's `pending-deletes` job can carry it out. How the pieces fit: docs/features/pending-deletes.md.

/** What carrying out a kept delete later needs from the delete that queued it. */
export type DeleteReplay = { moderatorDelete?: true; keepStoredFiles?: true };

export const PENDING_DELETES_ACTOR = { system: 'pending-deletes' } as const;

/**
 * The pending delete a kept row is queued as: the deleter's own, or anyone else's delete (a moderator's
 * or a system caller's) with what replaying it needs. Read against the unaliased table being deleted from.
 */
export function pendingRowData(actor: DeleteActor, replay: DeleteReplay = {}) {
  const other = (by: string) => JSON.stringify({ deletedBy: by, ...replay });
  if (!('id' in actor)) return sql`${other(actor.system)}::jsonb`;
  return sql`CASE WHEN "userId" = ${actor.id} THEN ${JSON.stringify({ ownerId: actor.id })}::jsonb
    ELSE ${other(`moderator:${actor.id}`)}::jsonb END`;
}

/**
 * A queued row's kind, from its data: a parent's `cleanup`, someone else's delete (`other`, it names
 * `deletedBy`), or the owner's `own`. Every rule below and the job start from this reading.
 */
export type PendingKind = 'own' | 'other' | 'cleanup';

export function pendingKindOf(data: PendingDelete): PendingKind {
  return data.cleanup ? 'cleanup' : data.deletedBy !== undefined ? 'other' : 'own';
}

function pendingKind(data: RawBuilder<unknown>) {
  return sql<PendingKind>`(CASE WHEN ${data} ? 'cleanup' THEN 'cleanup'
    WHEN ${data} ? 'deletedBy' THEN 'other' ELSE 'own' END)`;
}

const pendingRank = (column: string) => {
  const data = sql.raw(column);
  return sql`(CASE WHEN ${data} ? 'moderatorDelete' THEN 3
    WHEN ${pendingKind(data)} <> 'cleanup' THEN 2 ELSE 1 END)`;
};

// A stronger kind replaces a queued one (a moderator's delete or cleanup, anyone's outright delete, an
// owner's cleanup, strongest first) and the row keeps its earlier due time. An outright ask (`ownerId`,
// `deletedBy`) survives either way. A row a restore marked holds only the drain's ask, which the restore
// withdrew, so another ask on it replaces it whole and alone decides the kind. Anything else changes
// nothing.
export const PENDING_DELETE_UPSERT = sql`
  ON CONFLICT ("entityType", "entityId", "type") DO UPDATE
    SET "data" = CASE WHEN "JobQueue"."data" ? 'releasedOnRestore' THEN EXCLUDED."data" ELSE (CASE
        WHEN ${pendingRank('EXCLUDED."data"')} > ${pendingRank('"JobQueue"."data"')}
        THEN EXCLUDED."data" ELSE "JobQueue"."data" END
      || jsonb_strip_nulls(jsonb_build_object(
        'ownerId', COALESCE(EXCLUDED."data"->'ownerId', "JobQueue"."data"->'ownerId'),
        'deletedBy', COALESCE(EXCLUDED."data"->'deletedBy', "JobQueue"."data"->'deletedBy')))) END,
      "createdAt" = LEAST("JobQueue"."createdAt", EXCLUDED."createdAt")
    WHERE ${pendingRank('EXCLUDED."data"')} > ${pendingRank('"JobQueue"."data"')}
      OR (EXCLUDED."data" ? 'ownerId' AND NOT "JobQueue"."data" ? 'ownerId')
      OR (EXCLUDED."data" ? 'deletedBy' AND NOT "JobQueue"."data" ? 'deletedBy')
      OR "JobQueue"."data" ? 'releasedOnRestore'`;

/** `NsfwLevel.Blocked`. */
export const NSFW_LEVEL_BLOCKED = 32;

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
 * A delete that has to wait, one per entity in the `PendingDelete` queue: a delete a child-safety case
 * keeps (the owner's own, or anyone else's `deletedBy`), or a parent's cleanup of an image it no longer
 * uses. `moderatorDelete` marks a moderator's, of either kind. The main app's `pending-deletes` job
 * carries it out once nothing blocks it.
 */
export type PendingDelete = DeleteReplay & {
  ownerId?: number;
  deletedBy?: string;
  cleanup?: true;
  /** The account-deletion drain's ask, released by an account restore while a case held the row. */
  releasedOnRestore?: true;
};

const unsent: CsamReportFilter = (report) => `${report}."reportSentAt" IS NULL`;

// Each set below is uncorrelated, so Postgres builds it once per statement, and holds no NULL: a
// miss would then read NULL rather than false, and a NULL `blocked` row is neither deleted nor queued.

/**
 * A CSAM report not yet sent names `ownerId`, as its subject or its secondary user. The sender reads
 * that account and its content at send time, so all of it is held.
 */
const unsentReportNames = (ownerId: number | RawBuilder<unknown>) =>
  sql<boolean>`((${ownerId})::text IN (${sql.raw(csamReportNamedUserIdsSql(unsent))}))`;

/**
 * The image `imageId` is listed on a CSAM report not yet sent. Its owner may be named on none, so
 * only the image itself (and a post holding it) is held, not the rest of their content.
 */
const unsentReportLists = (imageId: RawBuilder<unknown>) =>
  sql<boolean>`((${imageId})::text IN (${sql.raw(csamReportListedImageIdsSql(unsent))}))`;

const unsentReportOn = {
  Image: (ownerId: number | RawBuilder<unknown>) =>
    sql<boolean>`(${unsentReportNames(ownerId)} OR ${unsentReportLists(sql.ref('Image.id'))})`,
  Post: (ownerId: number | RawBuilder<unknown>) => {
    const listed = unsentReportLists(sql.ref('pi.id'));
    return sql<boolean>`(${unsentReportNames(ownerId)} OR EXISTS (
      SELECT 1 FROM "Image" pi WHERE pi."postId" = "Post".id AND ${listed}
    ))`;
  },
};

/**
 * `ownerId`'s own row is held for a CSAM report not yet sent that names them, or lists the image (for
 * a post, an image in it). On top of the case, this keeps only the owner's own delete. Read against
 * the unaliased `table`.
 */
export const ownerReportHold = (table: 'Image' | 'Post', ownerId: number | RawBuilder<unknown>) =>
  sql<boolean>`(${sql.ref(`${table}.userId`)} = ${ownerId} AND ${unsentReportOn[table](ownerId)})`;

/** An owner's delete of their own image waits on its child-safety case or `ownerReportHold`. */
const ownImageDeleteBlocked = (ownerId: number | RawBuilder<unknown>) => {
  const reported = unsentReportOn.Image(ownerId);
  return sql<boolean>`("Image"."userId" = ${ownerId} AND (${childSafetyImageCase()} OR ${reported}))`;
};

/** An owner's delete of their own post waits on a child-safety report on it or `ownerReportHold`. */
const ownPostDeleteBlocked = (ownerId: number | RawBuilder<unknown>) => {
  const reported = unsentReportOn.Post(ownerId);
  return sql<boolean>`("Post"."userId" = ${ownerId} AND (${childSafetyPostCase()} OR ${reported}))`;
};

/**
 * `id` has a pending delete queued; with `ownerAsked`, one its owner asked for. Read for who may be
 * told and for what a post still waits on.
 */
export const pendingDeleteQueued = (
  entityType: 'Image' | 'Post',
  id: RawBuilder<unknown>,
  { ownerAsked = false } = {}
) => sql<boolean>`EXISTS (
  SELECT 1 FROM "JobQueue" pdq
  WHERE pdq.type = 'PendingDelete' AND pdq."entityType" = ${entityType}::"EntityType"
    AND pdq."entityId" = ${id}${ownerAsked ? sql` AND pdq.data ? 'ownerId'` : sql``}
)`;

/**
 * A post someone else deleted waits on its child-safety report and on any of its images still queued
 * for deletion, which go first. Read against "Post".
 */
const otherPostDeleteBlocked = sql<boolean>`(${childSafetyPostCase()}
  OR EXISTS (
    SELECT 1 FROM "Image" pd_i
    WHERE pd_i."postId" = "Post".id AND ${pendingDeleteQueued('Image', sql.ref('pd_i.id'))}
  ))`;

/** What keeps the pending delete `data` (a queue row's) of a post, read against "Post". */
export const postDeleteBlocked = (data: RawBuilder<unknown>) =>
  sql<boolean>`CASE ${pendingKind(data)} WHEN 'other' THEN ${otherPostDeleteBlocked}
    ELSE ${ownPostDeleteBlocked(sql`(${data}->>'ownerId')::int`)} END`;

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
  sql<boolean>`CASE ${pendingKind(data)}
    WHEN 'cleanup' THEN CASE WHEN ${data} ? 'moderatorDelete' THEN ${cleanupBlocked(
    true,
    heldOwner
  )}
      ELSE ${cleanupBlocked(false, heldOwner)} END
    WHEN 'other' THEN ${childSafetyImageCase()}
    ELSE ${ownImageDeleteBlocked(sql`(${data}->>'ownerId')::int`)}
  END`;

/**
 * Of `imageIds`, those with a pending delete their owner asked for, whose case they can see
 * (`childSafetyVisibleCase`): only those owners may be told their delete waits on a review.
 */
export async function imagesPendingDeletion(db: Kysely<DB>, imageIds: number[]) {
  const ids = [...new Set(imageIds)];
  if (!ids.length) return new Set<number>();
  const { rows } = await sql<{ id: number }>`
    SELECT id FROM "Image"
    WHERE id = ANY(${ids}::int[]) AND ${childSafetyVisibleCase()}
      AND ${pendingDeleteQueued('Image', sql.ref('Image.id'), { ownerAsked: true })}
  `.execute(db);
  return new Set(rows.map((row) => row.id));
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
  // An outright delete comes due just inside the job's 5-minute interval, so the next run takes it; a
  // cleanup waits on moderation, so hourly.
  if (waiting.length)
    await sql`
      UPDATE "JobQueue"
      SET "createdAt" = now() + CASE
          WHEN ${pendingKind(
            sql.ref('data')
          )} = 'cleanup' AND NOT data ?| array['ownerId', 'deletedBy']
          THEN interval '1 hour' ELSE interval '4 minutes' END,
        data = data - 'attempted'
      WHERE ${of(waiting)}
    `.execute(db);
  if (failed.length)
    await sql`
      UPDATE "JobQueue" SET data = data || '{"attempted": true}'::jsonb WHERE ${of(failed)}
    `.execute(db);
}

/**
 * Takes a moderator's delete off these images' pending deletes, for a lift that reverses it (an
 * unblock or an approved appeal). A row only a moderator asked for goes; one the owner also asked for
 * keeps the owner's ask, and a moderator's cleanup stays queued as a cleanup (the job deletes it only
 * while the image is unused). A plain cleanup the moderator's delete outranked in the merge is gone,
 * and goes with the row.
 */
export async function releaseModeratorPendingDeletes(db: Kysely<DB>, imageIds: number[]) {
  if (!imageIds.length) return;
  const queued = sql`q.type = 'PendingDelete' AND q."entityType" = 'Image'
    AND q."entityId" = ANY(${imageIds}::int[]) AND q.data ? 'moderatorDelete' AND q.data ? 'deletedBy'`;
  const keeps = sql`q.data ?| array['ownerId', 'cleanup']`;
  await sql`
    WITH stripped AS (
      UPDATE "JobQueue" q SET data = CASE WHEN q.data ? 'cleanup'
          THEN q.data - 'deletedBy' - 'keepStoredFiles'
          ELSE q.data - 'deletedBy' - 'moderatorDelete' - 'keepStoredFiles' END
      WHERE ${queued} AND ${keeps}
    )
    DELETE FROM "JobQueue" q WHERE ${queued} AND NOT ${keeps}
  `.execute(db);
}
