import { imageNotUsed } from '@civitai/db-queries/content-deletion';
import {
  cleanupBlocked,
  imageDeleteBlocked,
  pendingKindOf,
  PENDING_DELETES_ACTOR,
  postDeleteBlocked,
  readDueDeletes,
  settleDeletes,
  type PendingDelete,
} from '@civitai/db-queries/pending-deletes';
import { Prisma } from '@prisma/client';
import { sql } from 'kysely';
import { dbWrite } from '~/server/db/client';
import { kyselyOver } from '~/server/db/prisma-kysely';
import { fromPrismaSql } from '~/server/db/prisma-sql-kysely';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { deleteImages } from '~/server/services/image.service';
import { ownerHeldSql } from '~/server/services/legal-hold.service';
import { deletePost } from '~/server/services/post.service';
import { heldPostTextPostIds } from '~/server/services/post-text-hold';

const BATCH_SIZE = 500;

type Kind = 'Image' | 'Post';
type Row = { id: number; data: PendingDelete; attempted: boolean };

const db = () => kyselyOver(dbWrite);

/**
 * A held owner, or one with a safety report on file, keeps every image a cleanup would take, since
 * the review needs them. Only valid on a statement over an unaliased "Image".
 */
export const heldOwner = () =>
  fromPrismaSql<boolean>(Prisma.sql`(
    ${ownerHeldSql(Prisma.raw('"Image"."userId"'))}
    OR EXISTS (SELECT 1 FROM "CsamReport" r WHERE r."userId" = "Image"."userId")
  )`);

/**
 * What a cleanup's DELETE takes: an image still unused, since it may have been linked again, unless
 * someone also asked for it outright.
 */
const cleanupStillApplies = (moderatorDelete: boolean, asked: boolean) => {
  const free = sql<boolean>`NOT ${cleanupBlocked(moderatorDelete, heldOwner())}`;
  return asked ? free : sql<boolean>`${imageNotUsed()} AND ${free}`;
};

const ownerActor = (data: PendingDelete) => ({ id: Number(data.ownerId), isModerator: false });

/** How each kind of pending delete is carried out, and what rows replay together. */
function replay(entity: Kind, data: PendingDelete) {
  const mod = !!data.moderatorDelete;
  switch (pendingKindOf(data)) {
    case 'cleanup': {
      const asked = data.ownerId !== undefined || data.deletedBy !== undefined;
      return {
        key: `cleanup:${mod}:${asked}`,
        remove: (ids: number[]) =>
          deleteImages(ids, {
            actor: PENDING_DELETES_ACTOR,
            onlyWhere: cleanupStillApplies(mod, asked),
            moderatorDelete: mod,
          }),
      };
    }
    case 'other':
      return {
        key: `other:${mod}:${!!data.keepStoredFiles}`,
        remove:
          entity === 'Post'
            ? // A moderator's post delete again takes every image in the post, with the purge.
              ([postId]: number[]) =>
                deletePost({
                  id: postId,
                  actor: PENDING_DELETES_ACTOR,
                  isModerator: !!data.deletedBy?.startsWith('moderator:'),
                })
            : (ids: number[]) =>
                deleteImages(ids, {
                  actor: PENDING_DELETES_ACTOR,
                  moderatorDelete: mod,
                  keepStoredFiles: !!data.keepStoredFiles,
                }),
      };
    case 'own':
      return {
        key: `own:${data.ownerId}`,
        remove:
          entity === 'Post'
            ? ([postId]: number[]) => deletePost({ id: postId, actor: ownerActor(data) })
            : (ids: number[]) => deleteImages(ids, { actor: ownerActor(data) }),
      };
  }
}

/** Of the queued `ids`, each entity still present, and whether its pending delete is blocked now. */
async function standing(kind: Kind, ids: number[]) {
  const blocked =
    kind === 'Image'
      ? imageDeleteBlocked(sql.ref('q.data'), heldOwner())
      : postDeleteBlocked(sql.ref('q.data'));
  const { rows } = await sql<{ id: number; present: boolean; blocked: boolean }>`
    SELECT q."entityId" AS id, ${sql.table(kind)}.id IS NOT NULL AS present,
      CASE WHEN ${sql.table(kind)}.id IS NULL THEN false ELSE ${blocked} END AS blocked
    FROM "JobQueue" q
    LEFT JOIN ${sql.table(kind)} ON ${sql.table(kind)}.id = q."entityId"
    WHERE q.type = 'PendingDelete' AND q."entityType" = ${kind}::"EntityType"
      AND q."entityId" = ANY(${ids}::int[])
  `.execute(db());
  return new Map(rows.map(({ id, ...row }) => [id, row]));
}

/**
 * Carries out each pending delete as its kind says: a cleanup while `cleanupStillApplies`, anyone
 * else's as the system with the flags it was queued with (no caller condition), an owner's as the
 * owner. Returns the ids whose delete threw; a batch that throws is retried one at a time, and a
 * retry always runs alone, so one bad row cannot fail the rest.
 */
async function carryOut(kind: Kind, rows: Row[]) {
  const failed: number[] = [];
  const attempt = async (ids: number[], remove: (ids: number[]) => Promise<unknown>) => {
    try {
      await remove(ids);
    } catch (error) {
      if (ids.length > 1) {
        for (const id of ids) await attempt([id], remove);
        return;
      }
      failed.push(...ids);
      logToAxiom({
        type: 'error',
        name: 'pending-deletes',
        message: `${kind} delete failed; it stays queued`,
        ids,
        error: (error as Error).message,
      });
    }
  };

  const groups = new Map<string, { ids: number[]; remove: (ids: number[]) => Promise<unknown> }>();
  for (const { id, data, attempted } of rows) {
    const { remove, key } = replay(kind, data);
    // A post goes alone, and a retry goes alone; images batch by what replays them.
    const groupKey = kind === 'Post' || attempted ? `one:${id}` : key;
    const group = groups.get(groupKey) ?? { ids: [], remove };
    group.ids.push(id);
    groups.set(groupKey, group);
  }
  for (const { ids, remove } of groups.values()) await attempt(ids, remove);
  return failed;
}

/**
 * Carries out the deletes that had to wait (`PendingDelete`) once nothing blocks them: a delete once
 * its child-safety case closes, a parent's cleanup once its image is free of moderation and holds. One
 * linked again, given away or kept by a hold marker is done with. See docs/features/pending-deletes.md.
 */
export const pendingDeletes = createJob('pending-deletes', '*/5 * * * *', async () => {
  const result: Record<string, unknown> = {};
  for (const kind of ['Image', 'Post'] as const) {
    const rows = await readDueDeletes(db(), kind, BATCH_SIZE);
    const ids = rows.map((row) => row.id);
    if (!ids.length) continue;

    // Read once, up front: a row blocked now waits its turn even if the block ends during this run.
    const before = await standing(kind, ids);
    const textHeld = new Set(
      kind === 'Post'
        ? await heldPostTextPostIds({ postIds: ids.filter((id) => before.get(id)?.present) })
        : []
    );
    const due = rows.filter(
      (row) => before.get(row.id)?.present && !before.get(row.id)?.blocked && !textHeld.has(row.id)
    );
    const dueIds = new Set(due.map((row) => row.id));
    const threw = new Set(await carryOut(kind, due));

    // A row carried out is done once gone or no longer applicable (in use again, given away, kept by
    // a hold marker); blocked again it waits, and a delete that threw is retried.
    const after = await standing(kind, ids);
    const done: number[] = [];
    const waiting: number[] = [];
    const failed: number[] = [];
    for (const id of ids) {
      const now = after.get(id);
      if (!now?.present) done.push(id);
      else if (!dueIds.has(id) || now.blocked) waiting.push(id);
      else if (threw.has(id)) failed.push(id);
      else done.push(id);
    }
    await settleDeletes(db(), kind, { done, waiting, failed });

    result[kind] = {
      queued: ids.length,
      done: done.length,
      waiting: waiting.length,
      failed: failed.length,
    };
  }
  return result;
});
