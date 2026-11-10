import { dbWrite } from '~/server/db/client';
import { prismaRunner, setCommentFlags } from '~/server/services/commentv3/write.service';

export type ScamCleanup = 'chatMessages' | 'comments' | 'none';
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

/** Hides, or shows again, the user's live comments, optionally only those of `among`. */
async function setCommentsHidden(userId: number, hidden: boolean, among?: number[]) {
  const ids = (
    await dbWrite.$queryRaw<IdRow[]>`
      SELECT id FROM "CommentV3"
      WHERE "userId" = ${userId} AND "deletedAt" IS NULL AND hidden = ${!hidden}
        AND (${!among}::boolean OR id = ANY(${among ?? []}::int[]))`
  ).map((r) => r.id);
  // One transaction: a partial hide would leave comments hidden with no record to restore them by.
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
      return setCommentsHidden(userId, true);
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

type StoredCleanup = ScamCleanupRecord & { migrated?: boolean };

/**
 * A `comments` record on a `Comment` trigger predates the model flip and holds v1 ids, until the Phase 5
 * stored-records SQL maps them (`migrated`). The new code writes `CommentV3` triggers only.
 */
async function storedCommentIds(record: StoredCleanup, triggerType: unknown) {
  if (triggerType !== 'Comment' || record.migrated) return record.ids;
  const rows = await dbWrite.$queryRaw<IdRow[]>`
    SELECT id FROM "CommentV3" WHERE "legacyV1Id" = ANY(${record.ids}::int[])`;
  return rows.map((r) => r.id);
}

async function restore(userId: number, record: StoredCleanup, triggerType: unknown) {
  switch (record.kind) {
    case 'chatMessages':
      // By the exact timestamp written, so messages the user deleted themselves stay deleted.
      return dbWrite.$executeRaw`
        UPDATE "ChatMessage" SET "deletedAt" = NULL
        WHERE "chatId" IN (SELECT "chatId" FROM "ChatMember" WHERE "userId" = ${userId})
          AND "userId" = ${userId} AND "deletedAt" = ${new Date(record.at)}
      `;
    case 'comments':
      return (await setCommentsHidden(userId, false, await storedCommentIds(record, triggerType)))
        .length;
    default:
      // `commentsV2`, no longer written, also holds CommentV3 ids.
      if ((record.kind as string) === 'commentsV2')
        return (await setCommentsHidden(userId, false, record.ids)).length;
      return 0;
  }
}

export async function restoreScamCase(userRestrictionId: number) {
  const row = await dbWrite.userRestriction.findUnique({
    where: { id: userRestrictionId },
    select: { userId: true, type: true, triggers: true },
  });
  if (!row || row.type !== 'scam' || !Array.isArray(row.triggers)) return { restored: 0 };

  let restored = 0;
  for (const trigger of row.triggers as { entityType?: string; cleanup?: StoredCleanup | null }[]) {
    const record = trigger?.cleanup;
    if (!record?.count) continue;
    restored += await restore(row.userId, record, trigger.entityType);
  }
  return { restored };
}
