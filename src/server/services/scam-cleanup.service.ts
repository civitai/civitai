import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import {
  hasV3SurfaceTwinSql,
  prismaRunner,
  setCommentFlags,
  v3SurfaceCommentIds,
} from '~/server/services/commentv3/write.service';

export type ScamCleanup = 'chatMessages' | 'comments' | 'commentsV2' | 'none';
export const SCAM_CLEANUP_MAX_RECORDED_IDS = 5000;

export type ScamCleanupRecord = {
  kind: Exclude<ScamCleanup, 'none'>;
  /** ISO. For chat it is the exact `deletedAt` written, which is what the restore matches on. */
  at: string;
  count: number;
  ids: number[];
  truncated: boolean;
};

type IdRow = { id: number };

// The `commentsV2` kind also covers CommentV3-write surfaces. The tables share one id sequence, so
// one id list restores both. A comment there is set through `setCommentFlags`, CommentV3 first with
// its CommentV2 row kept in step, the lock order of every write on those surfaces; the CommentV2
// update leaves it out.
async function setV3SurfaceHidden(userId: number, hidden: boolean, among?: number[]) {
  const ids = await v3SurfaceCommentIds(
    prismaRunner(dbWrite),
    userId,
    hidden ? 'NOT hidden' : 'hidden',
    among
  );
  if (!ids.length) return [];
  return dbWrite.$transaction((tx) => setCommentFlags(prismaRunner(tx), ids, { hidden }));
}

function affectedRows(kind: Exclude<ScamCleanup, 'none'>, userId: number, at: Date) {
  switch (kind) {
    case 'chatMessages':
      // ChatMessage has no index on userId alone; the sender's chats let (chatId, userId) serve it.
      return dbWrite.$queryRaw<IdRow[]>`
        UPDATE "ChatMessage" SET "deletedAt" = ${at}
        WHERE "chatId" IN (SELECT "chatId" FROM "ChatMember" WHERE "userId" = ${userId})
          AND "userId" = ${userId} AND "deletedAt" IS NULL
        RETURNING id
      `;
    case 'comments':
      // `hidden`, not the ToS removal: that is the ban path, which notifies and settles rewards per
      // comment. This one has to be undone by id when a moderator overturns the mute.
      return dbWrite.$queryRaw<IdRow[]>`
        UPDATE "Comment" SET hidden = true, "updatedAt" = ${at}
        WHERE "userId" = ${userId} AND hidden IS NOT TRUE
        RETURNING id
      `;
    case 'commentsV2':
      return (async () => [
        ...(await dbWrite.$queryRaw<IdRow[]>`
          UPDATE "CommentV2" c2 SET hidden = true, "updatedAt" = ${at}
          WHERE c2."userId" = ${userId} AND c2.hidden IS NOT TRUE
            AND NOT ${Prisma.raw(hasV3SurfaceTwinSql('c2'))}
          RETURNING id
        `),
        ...(await setV3SurfaceHidden(userId, true)).map(({ id }) => ({ id })),
      ])();
  }
}

export async function runScamCleanup(
  kind: ScamCleanup,
  userId: number
): Promise<ScamCleanupRecord | null> {
  if (kind === 'none') return null;
  const at = new Date();
  const ids = (await affectedRows(kind, userId, at)).map((row) => row.id);
  return {
    kind,
    at: at.toISOString(),
    count: ids.length,
    ids: ids.slice(0, SCAM_CLEANUP_MAX_RECORDED_IDS),
    truncated: ids.length > SCAM_CLEANUP_MAX_RECORDED_IDS,
  };
}

function restore(userId: number, record: ScamCleanupRecord) {
  switch (record.kind) {
    case 'chatMessages':
      // By the exact timestamp written, so messages the user deleted themselves stay deleted.
      return dbWrite.$executeRaw`
        UPDATE "ChatMessage" SET "deletedAt" = NULL
        WHERE "chatId" IN (SELECT "chatId" FROM "ChatMember" WHERE "userId" = ${userId})
          AND "userId" = ${userId} AND "deletedAt" = ${new Date(record.at)}
      `;
    case 'comments':
      return dbWrite.$executeRaw`
        UPDATE "Comment" SET hidden = false
        WHERE id = ANY(${record.ids}::int[]) AND "userId" = ${userId} AND hidden
      `;
    case 'commentsV2':
      return (async () => {
        const v2 = await dbWrite.$executeRaw`
          UPDATE "CommentV2" c2 SET hidden = false
          WHERE c2.id = ANY(${record.ids}::int[]) AND c2."userId" = ${userId} AND c2.hidden
            AND NOT ${Prisma.raw(hasV3SurfaceTwinSql('c2'))}
        `;
        return v2 + (await setV3SurfaceHidden(userId, false, record.ids)).length;
      })();
  }
}

export async function restoreScamCase(userRestrictionId: number) {
  const row = await dbWrite.userRestriction.findUnique({
    where: { id: userRestrictionId },
    select: { userId: true, type: true, triggers: true },
  });
  if (!row || row.type !== 'scam' || !Array.isArray(row.triggers)) return { restored: 0 };

  let restored = 0;
  for (const trigger of row.triggers as { cleanup?: ScamCleanupRecord | null }[]) {
    const record = trigger?.cleanup;
    if (!record?.count) continue;
    restored += await restore(row.userId, record);
  }
  return { restored };
}
