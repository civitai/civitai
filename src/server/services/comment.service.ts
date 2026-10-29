import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import type { SessionUser } from '~/types/session';
import { isEqual, omit } from 'lodash-es';
import { NotificationCategory } from '~/server/common/enums';
import { reportAcceptedReward } from '~/server/rewards';
import { createNotification } from '~/server/services/notification.service';
import { logToAxiom } from '~/server/logging/client';
import {
  accountHoldSql,
  holdMarkerViewExists,
  logHoldRetained,
} from '~/server/services/legal-hold.service';
import {
  afterCommentsV2Deleted,
  deleteCommentsV2UnlessHeld,
} from '~/server/services/commentsv2.service';
import { recordStickerUsage, spendStickerUses } from '~/server/services/sticker.service';

import { ReviewFilter } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  getDbWithoutLag,
  getKyselyWithoutLag,
  preventReplicationLag,
} from '~/server/db/db-lag-helpers';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  countTopLevelCommentsByHiddenViaKysely,
  countTopLevelCommentsByHiddenViaPrisma,
  countTopLevelCommentsViaKysely,
  countTopLevelCommentsViaPrisma,
  findPinnedCommentsViaPrisma,
  findTopLevelCommentsViaPrisma,
  listPinnedCommentsViaKysely,
  listTopLevelCommentsViaKysely,
  type CommentCountsByHidden,
  type KyselyCommentListSort,
  type PinnedScope,
  type TopLevelCommentsBaseFilter,
  type TopLevelCommentsFilter,
} from '~/server/services/hot-reads-4.reads';
import { modelMetrics, userMetrics } from '~/server/metrics';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type {
  CommentUpsertInput,
  GetAllCommentsSchema,
  GetCommentCountByModelInput,
  GetCommentCountsByModelInput,
  GetCommentReactionsSchema,
} from '~/server/schema/comment.schema';
import { getAllCommentsSelect } from '~/server/selectors/comment.selector';
import { getReactionsSelect } from '~/server/selectors/reaction.selector';
import {
  BlockedByUsers,
  BlockedUsers,
  HiddenUsers,
} from '~/server/services/user-preferences.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { boundExcludedUserIds } from '~/server/utils/excluded-user-ids';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';
import type { ReportReason, ReportStatus, ReviewReactions } from '~/shared/utils/prisma/enums';
import { queueScamScan } from '~/server/services/text-scan/scam-scan-queue';

type ModelCommentsFilterInput = Pick<GetAllCommentsSchema, 'modelId' | 'userId' | 'hidden'>;

type ViewerExclusionLists = {
  hiddenUsers: number[];
  blockedByUsers: number[];
  blockedUsers: number[];
};

async function getViewerExclusionLists(
  user: SessionUser | undefined
): Promise<ViewerExclusionLists> {
  const hiddenUsers = (await HiddenUsers.getCached({ userId: user?.id })).map((x) => x.id);
  const blockedByUsers = (await BlockedByUsers.getCached({ userId: user?.id })).map((x) => x.id);
  const blockedUsers = (await BlockedUsers.getCached({ userId: user?.id })).map((x) => x.id);
  return { hiddenUsers, blockedByUsers, blockedUsers };
}

/**
 * The filter shared by the comment list, the pinned list and the visible count so they can't drift.
 * Both the Prisma where (`topLevelCommentsWhere`) and the Kysely statements behind
 * `kysely-hot-reads-4` are pure functions of it (hot-reads-4.reads.ts).
 * Pass `lists` when building more than one filter for the same viewer, so the lists are read once.
 */
async function getTopLevelCommentsFilter(
  { modelId, userId, hidden = false }: ModelCommentsFilterInput,
  user: SessionUser | undefined,
  { ownerSeesBlockers }: { ownerSeesBlockers: boolean },
  lists?: ViewerExclusionLists
): Promise<TopLevelCommentsFilter> {
  const isMod = user?.isModerator ?? false;

  const { hiddenUsers, blockedByUsers, blockedUsers } =
    lists ?? (await getViewerExclusionLists(user));
  // If the viewer owns the model, don't hide a blocker's comments from them (the owner must
  // still see + report engagement on their own content) — drop blockedByUsers only then; keep
  // the anti-harassment exclusion for every non-owner viewer. Skip the lookup unless the
  // viewer actually has a blocked-by list, since that's the only case it can change anything.
  let isContentOwner = false;
  if (ownerSeesBlockers && user?.id && blockedByUsers.length) {
    const model = await dbRead.model.findUnique({
      where: { id: modelId },
      select: { userId: true },
    });
    isContentOwner = model?.userId === user.id;
  }
  // De-dupe + cap the exclusion list so the `userId NOT IN (...)` negation stays under the
  // Postgres bind-parameter limit (a heavily-blocked viewer's combined list can otherwise
  // overflow → Prisma P2029 → 500). Ordering is a load-bearing safety priority — see
  // boundExcludedUserIds.
  const excludedUserIds = boundExcludedUserIds(hiddenUsers, blockedByUsers, blockedUsers, {
    isContentOwner,
  });

  return {
    modelId,
    userId: userId ? userId : undefined,
    excludedUserIds,
    excludeTosViolations: !isMod,
    hidden,
  };
}

export const getComments = async <TSelect extends Prisma.CommentSelect>({
  input: { limit = DEFAULT_PAGE_SIZE, page, cursor, filterBy, sort, ...filter },
  select,
  user,
}: {
  input: GetAllCommentsSchema;
  select: TSelect;
  user?: SessionUser;
}) => {
  const skip = page ? (page - 1) * limit : undefined;

  if (filterBy?.includes(ReviewFilter.IncludesImages)) return [];

  const topLevel = await getTopLevelCommentsFilter(filter, user, { ownerSeesBlockers: true });

  const db = await getDbWithoutLag('commentModel', filter.modelId);
  return findTopLevelCommentsViaPrisma(db, topLevel, { limit, skip, cursor, sort }, select);
};

export const getPinnedComments = async <TSelect extends Prisma.CommentSelect>({
  input: { filterBy, ...filter },
  select,
  user,
}: {
  input: GetAllCommentsSchema;
  select: TSelect;
  user?: SessionUser;
}) => {
  if (filterBy?.includes(ReviewFilter.IncludesImages)) return [];

  const topLevel = await getTopLevelCommentsFilter(filter, user, { ownerSeesBlockers: false });

  const db = await getDbWithoutLag('commentModel', filter.modelId);
  return findPinnedCommentsViaPrisma(db, topLevel, select);
};

/**
 * `getComments` with the `comment.getAll` select, through Kysely (`kysely-hot-reads-4` on), for a
 * page `isKyselyCommentListPage` accepts: the first page, newest or oldest first. Same filter, same
 * lag decision (`getKyselyWithoutLag` is `getDbWithoutLag`'s twin).
 */
export const getCommentsViaKysely = async ({
  input: { limit = DEFAULT_PAGE_SIZE, page, filterBy, sort, ...filter },
  user,
}: {
  input: GetAllCommentsSchema & { cursor?: undefined; sort: KyselyCommentListSort };
  user?: SessionUser;
}) => {
  const skip = page ? (page - 1) * limit : undefined;

  if (filterBy?.includes(ReviewFilter.IncludesImages)) return [];

  const topLevel = await getTopLevelCommentsFilter(filter, user, { ownerSeesBlockers: true });

  const db = await getKyselyWithoutLag('commentModel', filter.modelId);
  return listTopLevelCommentsViaKysely(db, topLevel, { limit, skip, sort });
};

/** `getPinnedComments` with the `comment.getAll` select, through Kysely (`kysely-hot-reads-4` on). */
export const getPinnedCommentsViaKysely = async ({
  input: { filterBy, ...filter },
  user,
}: {
  input: GetAllCommentsSchema;
  user?: SessionUser;
}) => {
  if (filterBy?.includes(ReviewFilter.IncludesImages)) return [];

  const topLevel = await getTopLevelCommentsFilter(filter, user, { ownerSeesBlockers: false });

  const db = await getKyselyWithoutLag('commentModel', filter.modelId);
  return listPinnedCommentsViaKysely(db, topLevel);
};

/** How many top-level comments `getComments` + `getPinnedComments` can return to this viewer. */
export const getVisibleCommentCount = async ({
  input,
  user,
}: {
  input: GetCommentCountByModelInput;
  user?: SessionUser;
}) => {
  // `kysely-hot-reads-4` on: the same counts through Kysely, on the client the same lag decision
  // picks (`getKyselyWithoutLag` is `getDbWithoutLag`'s twin).
  let count: (filter: TopLevelCommentsFilter, pinned: PinnedScope) => Promise<number>;
  if (await isFlipt(FLIPT_FEATURE_FLAGS.KYSELY_HOT_READS_4)) {
    const db = await getKyselyWithoutLag('commentModel', input.modelId);
    count = (filter, pinned) => countTopLevelCommentsViaKysely(db, filter, pinned);
  } else {
    const db = await getDbWithoutLag('commentModel', input.modelId);
    count = (filter, pinned) => countTopLevelCommentsViaPrisma(db, filter, pinned);
  }
  const lists = await getViewerExclusionLists(user);
  const [unpinnedFilter, pinnedFilter] = await Promise.all([
    getTopLevelCommentsFilter(input, user, { ownerSeesBlockers: true }, lists),
    getTopLevelCommentsFilter(input, user, { ownerSeesBlockers: false }, lists),
  ]);
  // The two filters differ only when the viewer owns the model AND has a blocked-by list (the
  // unpinned list then lets the owner see blockers' comments; the pinned list does not). In
  // every other case they are identical, and `pinnedAt IS NULL` / `IS NOT NULL` partition the
  // rows, so one COUNT over the shared filter equals the sum of the two. Don't fold the
  // differing case into a single OR: it would bind both `notIn` lists in one statement, and
  // each is capped just under the bind-parameter limit on its own (boundExcludedUserIds).
  if (isEqual(unpinnedFilter, pinnedFilter)) return count(unpinnedFilter, 'any');
  const [unpinned, pinned] = await Promise.all([
    count(unpinnedFilter, 'unpinned'),
    count(pinnedFilter, 'pinned'),
  ]);
  return unpinned + pinned;
};

/**
 * `getVisibleCommentCount` for the plain view (`visible`) and the hidden view (`hidden`) at once,
 * for `comment.getVisibleCountsByModel`: each equals the single count with `hidden: false` /
 * `hidden: true` for the same viewer, from ONE statement where the two calls issued two (two where
 * they issued four, for a model owner with a blocked-by list). With `includeVisible: false` (the
 * client already holds every visible comment) only the hidden count runs, and `visible` is `null`.
 */
export const getVisibleCommentCounts = async ({
  input: { modelId, includeVisible },
  user,
}: {
  input: GetCommentCountsByModelInput;
  user?: SessionUser;
}): Promise<{ visible: number | null; hidden: number }> => {
  if (!includeVisible)
    return {
      visible: null,
      hidden: await getVisibleCommentCount({ input: { modelId, hidden: true }, user }),
    };

  // `kysely-hot-reads-4` on: through Kysely, on the client the same lag decision picks.
  let count: (
    filter: TopLevelCommentsBaseFilter,
    pinned: PinnedScope
  ) => Promise<CommentCountsByHidden>;
  if (await isFlipt(FLIPT_FEATURE_FLAGS.KYSELY_HOT_READS_4)) {
    const db = await getKyselyWithoutLag('commentModel', modelId);
    count = (filter, pinned) => countTopLevelCommentsByHiddenViaKysely(db, filter, pinned);
  } else {
    const db = await getDbWithoutLag('commentModel', modelId);
    count = (filter, pinned) => countTopLevelCommentsByHiddenViaPrisma(db, filter, pinned);
  }
  const lists = await getViewerExclusionLists(user);
  // `hidden` is the only part of the filter the two views differ by, so the filters below are the
  // single counts' filters without it, and the equal/differing split is the one each single count
  // makes.
  const [unpinnedFilter, pinnedFilter] = (
    await Promise.all([
      getTopLevelCommentsFilter({ modelId }, user, { ownerSeesBlockers: true }, lists),
      getTopLevelCommentsFilter({ modelId }, user, { ownerSeesBlockers: false }, lists),
    ])
  ).map((filter) => omit(filter, 'hidden'));
  if (isEqual(unpinnedFilter, pinnedFilter)) return count(unpinnedFilter, 'any');
  const [unpinned, pinned] = await Promise.all([
    count(unpinnedFilter, 'unpinned'),
    count(pinnedFilter, 'pinned'),
  ]);
  return { visible: unpinned.visible + pinned.visible, hidden: unpinned.hidden + pinned.hidden };
};

export const getCommentById = <TSelect extends Prisma.CommentSelect>({
  id,
  select,
  user,
}: GetByIdInput & { select: TSelect; user?: SessionUser }) => {
  const isMod = user?.isModerator ?? false;

  return dbRead.comment.findFirst({
    where: {
      id,
      tosViolation: !isMod ? false : undefined,
      model: isMod
        ? undefined
        : { OR: [{ status: 'Published' }, { userId: user?.id }], locked: false },
    },
    select,
  });
};

export const getCommentReactions = ({ commentId }: GetCommentReactionsSchema) => {
  return dbRead.commentReaction.findMany({
    where: { commentId },
    select: getReactionsSelect,
  });
};

export const getUserReactionByCommentId = ({
  reaction,
  userId,
  commentId,
}: {
  reaction: ReviewReactions;
  userId: number;
  commentId: number;
}) => {
  return dbRead.commentReaction.findFirst({ where: { reaction, userId, commentId } });
};

export const createOrUpdateComment = async ({
  ownerId,
  track,
  ...input
}: CommentUpsertInput & {
  ownerId: number;
  locked: boolean;
  track?: Parameters<typeof recordStickerUsage>[0]['track'];
}) => {
  const { id, locked, ...commentInput } = input;

  // If we are editing, but the comment is locked
  // prevent from updating
  if (id && locked)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This comment is locked and cannot be updated',
    });

  // Same rule as CommentV2: pay for stickers this edit added, so an empty
  // comment edited to add stickers isn't free. Charge and write share one
  // transaction so a failure can't debit uses and lose the comment.
  const previous = id
    ? await dbWrite.comment.findUnique({ where: { id }, select: { content: true } })
    : null;

  const { result, chargedStickers } = await dbWrite.$transaction(async (tx) => {
    const charged = await spendStickerUses({
      userId: ownerId,
      surface: 'comment',
      content: commentInput.content ?? '',
      previousContent: previous?.content ?? '',
      tx,
    });
    const row = await tx.comment.upsert({
      where: { id: id ?? -1 },
      create: { ...commentInput, userId: ownerId },
      update: { ...commentInput },
      select: {
        id: true,
        modelId: true,
        content: true,
        nsfw: true,
      },
    });
    return { result: row, chargedStickers: charged };
  });
  recordStickerUsage({
    track,
    userId: ownerId,
    charged: chargedStickers,
    entityType: 'commentOld',
    entityId: result.id,
  });
  await preventReplicationLag('commentModel', input.modelId);
  queueScamScan({ entityType: 'Comment', entityId: result.id });
  return result;
};

export const toggleHideComment = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId: number; isModerator: boolean }) => {
  const AND = [Prisma.sql`c.id = ${id}`];
  // Only comment owner, model owner, or moderator can hide comment
  if (!isModerator) AND.push(Prisma.sql`(m."userId" = ${userId} OR c."userId" = ${userId})`);

  const [comment] = await dbWrite.$queryRaw<{ hidden: boolean; modelId: number }[]>`
    SELECT
      c.hidden, c."modelId"
    FROM "Comment" c
    JOIN "Model" m ON m.id = c."modelId"
    WHERE ${Prisma.join(AND, ' AND ')}
  `;

  if (!comment) throw throwNotFoundError(`You don't have permission to hide this comment`);
  const hidden = comment.hidden;

  await dbWrite.comment.updateMany({
    where: { id },
    data: { hidden: !hidden },
  });
  await preventReplicationLag('commentModel', comment.modelId);
};

export const togglePinComment = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId: number; isModerator: boolean }) => {
  const AND = [Prisma.sql`c.id = ${id}`, Prisma.sql`c."parentId" IS NULL`];
  // Only the model owner or a moderator can pin a comment
  if (!isModerator) AND.push(Prisma.sql`m."userId" = ${userId}`);

  const [comment] = await dbWrite.$queryRaw<{ pinnedAt: Date | null; modelId: number }[]>`
    SELECT
      c."pinnedAt", c."modelId"
    FROM "Comment" c
    JOIN "Model" m ON m.id = c."modelId"
    WHERE ${Prisma.join(AND, ' AND ')}
  `;

  if (!comment) throw throwNotFoundError(`You don't have permission to pin this comment`);

  await dbWrite.comment.updateMany({
    where: { id },
    data: { pinnedAt: comment.pinnedAt ? null : new Date() },
  });
  await preventReplicationLag('commentModel', comment.modelId);
};

export const deleteCommentById = async ({ id }: GetByIdInput) => {
  const { modelId, model } =
    (await dbWrite.comment.findUnique({
      where: { id },
      select: { modelId: true, model: { select: { userId: true } } },
    })) ?? {};

  const deleted = await dbWrite.comment.delete({ where: { id } });
  if (!deleted) throw throwNotFoundError(`No comment with id ${id}`);
  await preventReplicationLag('commentModel', modelId);

  if (model?.userId) await userMetrics.queueUpdate(model.userId);
  if (modelId) await modelMetrics.queueUpdate(modelId);

  return deleted;
};

export const updateCommentById = async ({
  id,
  data,
}: {
  id: number;
  data: Prisma.CommentUpdateInput;
}) => {
  const results = await dbWrite.comment.update({
    where: { id },
    data,
    select: getAllCommentsSelect,
  });
  await preventReplicationLag('commentModel', results.modelId);
  return results;
};

export const updateCommentReportStatusByReason = ({
  id,
  reason,
  status,
  actorId,
}: {
  id: number;
  reason: ReportReason;
  status: ReportStatus;
  actorId: number;
}) => {
  // Skip reports that are already in the target status so re-running the
  // bulk TOS handler does not double-fire reportAcceptedReward.
  return dbWrite.$queryRaw<{ id: number; userId: number }[]>`
    UPDATE "Report" r SET
      status = ${status}::"ReportStatus",
      "statusSetAt" = now(),
      "statusSetBy" = ${actorId}
    FROM "CommentReport" c
    WHERE c."reportId" = r.id
      AND c."commentId" = ${id}
      AND r.reason = ${reason}::"ReportReason"
      AND r.status <> ${status}::"ReportStatus"
    RETURNING id, "userId"
  `;
};

export async function bulkSetCommentTosViolation({
  ids,
  actor,
}: {
  ids: number[];
  actor: { id: number; ip?: string };
}) {
  if (ids.length === 0) return { count: 0, notified: 0, rewardedReports: 0 };

  // Import enums lazily to avoid `Prisma` namespace collision in this file.
  const ReportReason = (await import('~/shared/utils/prisma/enums')).ReportReason;
  const ReportStatus = (await import('~/shared/utils/prisma/enums')).ReportStatus;

  let rewardedReports = 0;
  let notified = 0;
  // Rows actually flagged, NOT ids submitted: the loop skips a row whose update threw, and the caller
  // writes an audit row from this number.
  let count = 0;

  for (const id of ids) {
    const comment = await updateCommentById({ id, data: { tosViolation: true } }).catch(() => null);
    if (!comment) continue;
    count += 1;

    const reports = await updateCommentReportStatusByReason({
      id,
      reason: ReportReason.TOSViolation,
      status: ReportStatus.Actioned,
      actorId: actor.id,
    });
    rewardedReports += reports.length;

    await Promise.allSettled(
      reports.map((report) =>
        reportAcceptedReward.apply({ userId: report.userId, reportId: report.id }, { ip: actor.ip })
      )
    );

    await createNotification({
      userId: comment.user.id,
      type: 'tos-violation',
      category: NotificationCategory.System,
      key: `tos-violation:comment:${crypto.randomUUID()}`,
      details: { modelName: comment.model?.name ?? '', entity: 'comment' },
    })
      .then(() => {
        notified += 1;
      })
      .catch(() => undefined); // best-effort notification; a failure must not fail the action
  }

  return { count, notified, rewardedReports };
}

/**
 * The moderator bulk delete, over both comment tables in one transaction, so a hold abort in either
 * undoes both and nothing is deleted that the moderator app does not record.
 *
 * A held author's comments are kept, and taken off the page. The hold is in each DELETE itself, so
 * one that lands after this read still counts; what a DELETE left of its ids is what it kept.
 */
export async function bulkDeleteComments({
  commentIds,
  commentV2Ids,
}: {
  commentIds: number[];
  commentV2Ids: number[];
}) {
  const markerView = await holdMarkerViewExists();
  const { v1, v2 } = await dbWrite.$transaction(async (tx) => ({
    v1: await deleteLegacyCommentsUnlessHeld(tx, commentIds, markerView),
    v2: await deleteCommentsV2UnlessHeld(tx, commentV2Ids, markerView),
  }));
  // The deletes have committed, so a failing follow-up is logged and never reported as a failed
  // delete: the moderator app records only what the endpoint reports as done.
  const followUps = await Promise.allSettled([
    afterLegacyCommentsDeleted(v1),
    afterCommentsV2Deleted(v2),
  ]);
  for (const f of followUps)
    if (f.status === 'rejected')
      logToAxiom({
        type: 'error',
        name: 'comment-bulk-delete',
        message: 'A follow-up to a committed bulk comment delete failed',
        details: { error: (f.reason as Error)?.message },
      }).catch(() => undefined);
  return {
    commentDeleted: v1.deleted.length,
    commentV2Deleted: v2.deleted.length,
    retainedHidden: v1.retained.length + v2.retained.length,
  };
}

async function deleteLegacyCommentsUnlessHeld(
  tx: Prisma.TransactionClient,
  ids: number[],
  markerView: boolean
) {
  if (ids.length === 0) return { deleted: [], retained: [] };
  // A reply goes with its parent (the foreign key cascades), so a comment is also kept while any
  // reply under it, at any depth, is held. Checked once per author: its cost grows with the number
  // of holding reports.
  const deleted = await tx.$queryRaw<{ modelId: number }[]>`
    DELETE FROM "Comment" c
    WHERE c.id = ANY(${ids}::int[])
      AND NOT ${accountHoldSql(Prisma.sql`c."userId"`, markerView)}
      AND NOT EXISTS (
        WITH RECURSIVE below AS (
          SELECT r.id, r."userId" FROM "Comment" r WHERE r."parentId" = c.id
          UNION
          SELECT r.id, r."userId" FROM "Comment" r JOIN below b ON r."parentId" = b.id
        ),
        authors AS MATERIALIZED (SELECT DISTINCT "userId" FROM below)
        SELECT 1 FROM authors a WHERE ${accountHoldSql(Prisma.sql`a."userId"`, markerView)}
      )
    RETURNING c."modelId"
  `;
  const retained = await tx.$queryRaw<{ userId: number }[]>`
    UPDATE "Comment" SET "tosViolation" = true, "updatedAt" = now()
    WHERE id = ANY(${ids}::int[])
    RETURNING "userId"
  `;
  return { deleted, retained };
}

async function afterLegacyCommentsDeleted({
  deleted,
  retained,
}: Awaited<ReturnType<typeof deleteLegacyCommentsUnlessHeld>>) {
  if (retained.length)
    await logHoldRetained(
      'comment.bulkDelete',
      retained.map((r) => r.userId)
    );

  const modelIds = Array.from(new Set(deleted.map((c) => c.modelId)));
  const owners = modelIds.length
    ? await dbWrite.model.findMany({ where: { id: { in: modelIds } }, select: { userId: true } })
    : [];
  const userIds = Array.from(new Set(owners.map((m) => m.userId)));
  await Promise.all([
    ...modelIds.map((id) => preventReplicationLag('commentModel', id)),
    ...modelIds.map((id) => modelMetrics.queueUpdate(id)),
    ...userIds.map((id) => userMetrics.queueUpdate(id)),
  ]);
}

/**
 * The legacy twin of `bulkClearCommentV2TosViolation` — see that function for why an unflag exists at
 * all and for the two steps it deliberately does not mirror (rewards are not clawed back, and no
 * notification is sent).
 *
 * Does NOT reuse `updateCommentReportStatusByReason`: that helper guards on `status <> target`, which
 * when the target is `Pending` also sweeps up reports a moderator DISMISSED on their own judgement and
 * puts them back in the queue. Reopening is only ever correct for the ones this flag actioned.
 */
export const bulkClearCommentTosViolation = async ({ ids }: { ids: number[] }) => {
  if (ids.length === 0) return { count: 0, reopenedReports: 0 };

  const ReportReason = (await import('~/shared/utils/prisma/enums')).ReportReason;
  const ReportStatus = (await import('~/shared/utils/prisma/enums')).ReportStatus;

  let reopenedReports = 0;
  let count = 0;

  for (const id of ids) {
    const updated = await dbWrite.comment
      .update({ where: { id }, data: { tosViolation: false }, select: { id: true } })
      .catch(() => null);
    if (!updated) continue;
    count += 1;

    const reports = await dbWrite.$queryRaw<{ id: number }[]>`
      UPDATE "Report" r SET status = ${ReportStatus.Pending}::"ReportStatus"
      FROM "CommentReport" c
      WHERE c."reportId" = r.id
        AND c."commentId" = ${id}
        AND r.reason = ${ReportReason.TOSViolation}::"ReportReason"
        AND r.status = ${ReportStatus.Actioned}::"ReportStatus"
      RETURNING id
    `;
    reopenedReports += reports.length;
  }

  return { count, reopenedReports };
};
