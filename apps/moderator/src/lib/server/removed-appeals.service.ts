import { NotificationCategory } from '@civitai/notifications';
import { dbRead, dbWrite } from './db';
import { refundAppealFee } from './image-moderation-effects';
import { recordModActivity } from './mod-activity';
import { getNotifications } from './notifications';

/**
 * Appeals the main app's orphan sweep kept open after their image or model was deleted. The entity
 * queues are driven from the entity row, so this list is the only place they can be decided.
 */

export type RemovedAppealDecision = 'Approved' | 'Rejected' | 'OwnerDeleted';

// Spelled as in the main app's `OrphanedAppealOutcome` / `OrphanedAppealReason`; this app does not
// import from `src/`. The main app's notification copy reads these outcomes.
const OUTCOME = {
  Approved: 'reviewed-approved',
  Rejected: 'reviewed-rejected',
  OwnerDeleted: 'closed-owner-deleted',
} as const satisfies Record<RemovedAppealDecision, string>;
const DELETED_BY_OWNER = 'deleted-by-owner';

const pendingRemoved = () =>
  dbRead
    .selectFrom('Appeal as a')
    .where('a.status', '=', 'Pending')
    .where('a.entityRemovedAt', 'is not', null);

export async function countRemovedAppeals(): Promise<number> {
  const row = await pendingRemoved()
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function getRemovedAppeals({ limit }: { limit: number }) {
  const rows = await pendingRemoved()
    .leftJoin('User as u', 'u.id', 'a.userId')
    .select([
      'a.id',
      'a.userId',
      'u.username',
      'a.entityType',
      'a.entityId',
      'a.appealMessage',
      'a.createdAt',
      'a.entityRemovedAt',
      'a.buzzTransactionId',
    ])
    .orderBy('a.entityRemovedAt', 'asc')
    .orderBy('a.id', 'asc')
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);

  const history = page.length
    ? await dbRead
        .selectFrom('ModActivity')
        .select(['entityType', 'entityId', 'activity', 'userId', 'createdAt'])
        .where('entityId', 'in', [...new Set(page.map((r) => r.entityId))])
        .where('entityType', 'in', [...new Set(page.map((r) => r.entityType.toLowerCase()))])
        .orderBy('createdAt', 'asc')
        .execute()
    : [];

  return {
    hasMore: rows.length > limit,
    items: page.map(({ buzzTransactionId, ...row }) => ({
      ...row,
      hasFee: buzzTransactionId != null,
      history: history
        .filter((h) => h.entityId === row.entityId && h.entityType === row.entityType.toLowerCase())
        .map((h) => ({ activity: h.activity, moderatorId: h.userId, at: h.createdAt })),
    })),
  };
}

/**
 * Decides one removed-before-review appeal. False when it is no longer Pending (another moderator
 * decided it) or is not a removed one (its entity's own queue owns it).
 */
export async function resolveRemovedAppeal({
  appealId,
  decision,
  resolvedReason,
  internalNotes,
  resolvedMessage,
  moderatorId,
}: {
  appealId: number;
  decision: RemovedAppealDecision;
  resolvedReason?: string;
  internalNotes?: string;
  resolvedMessage?: string;
  moderatorId: number;
}): Promise<boolean> {
  // One statement claims and reads it, so two moderators deciding at once refund and notify once.
  const appeal = await dbWrite
    .updateTable('Appeal')
    .set({
      status: decision === 'OwnerDeleted' ? 'Void' : decision,
      resolvedBy: moderatorId,
      resolvedAt: new Date(),
      resolvedMessage: resolvedMessage ?? null,
      resolvedReason: decision === 'OwnerDeleted' ? DELETED_BY_OWNER : resolvedReason ?? null,
      internalNotes: internalNotes ?? null,
    })
    .where('id', '=', appealId)
    .where('status', '=', 'Pending')
    .where('entityRemovedAt', 'is not', null)
    .returning(['id', 'userId', 'entityType', 'entityId', 'buzzTransactionId'])
    .executeTakeFirst();
  if (!appeal) return false;

  const refunded =
    decision !== 'Rejected' &&
    (await refundAppealFee({
      id: appeal.id,
      buzzTransactionId: appeal.buzzTransactionId,
      entityType: appeal.entityType,
      entityId: appeal.entityId,
    }));

  const outcome = OUTCOME[decision];
  try {
    await getNotifications().createNotification({
      userId: appeal.userId,
      type: 'entity-appeal-content-removed',
      category: NotificationCategory.Other,
      // The worker drops a repeated key, so the outcome is part of it: the sweep already sent
      // this appeal's "under-review" notice.
      key: `entity-appeal-content-removed:${appeal.id}:${outcome}`,
      details: {
        entityType: appeal.entityType,
        entityId: appeal.entityId,
        outcome,
        refunded,
        ...(resolvedMessage ? { resolvedMessage } : {}),
      },
    });
  } catch {
    // onFailure already logged; best-effort.
  }

  await recordModActivity({
    userId: moderatorId,
    entityType: appeal.entityType.toLowerCase(),
    entityId: appeal.entityId,
    activity: 'resolveAppeal',
  });
  return true;
}
