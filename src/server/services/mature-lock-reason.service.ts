import { LOCK_REVIEW_KIND, parseLockReviewContext } from '@civitai/shared/lock-review';
import { dbRead } from '~/server/db/client';
import type { ModelMeta } from '~/server/schema/model.schema';
import { autoNsfwTextHash } from '~/server/services/auto-nsfw';
import { hasSystemNsfwLock } from '~/server/services/rating-review.entities';
import { readSystemNsfwLockAt } from '~/server/utils/minor-flag-meta';
import {
  isMatureLockCategory,
  type MatureLockField,
  type MatureLockReason,
} from '~/shared/constants/mature-lock-reason.constants';
import { EntityType } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';

type MatureLockSubject = {
  id: number;
  userId: number;
  nsfw: boolean | null;
  lockedProperties: (string | null)[] | null;
  minor: boolean | null;
  poi: boolean | null;
  sfwOnly: boolean | null;
  name: string | null;
  description: string | null;
  meta: unknown;
};

const MATURE_LOCK_FIELDS: readonly string[] = ['name', 'description'] satisfies MatureLockField[];
/** Locks with their own owner-facing explanation. */
const OTHER_SAFETY_LOCKS = ['minor', 'poi', 'sfwOnly'];

/**
 * The reason stored when the save-time text filter set the nsfw lock, while the text it was read
 * from is unchanged. Null for every other lock, and whenever anything is in doubt.
 */
export function storedMatureLockReason(
  model: MatureLockSubject
): { reason: MatureLockReason; at: Date } | null {
  const locked = model.lockedProperties ?? [];
  if (!model.nsfw || !locked.includes('nsfw')) return null;
  if (model.minor || model.poi || model.sfwOnly) return null;
  if (locked.some((key) => !!key && OTHER_SAFETY_LOCKS.includes(key))) return null;

  const meta = model.meta as ModelMeta | null;
  const marker = meta?.systemNsfwLock;
  const at = readSystemNsfwLockAt(meta);
  if (!marker || marker.source !== 'profanity-filter' || !at) return null;
  if (!isMatureLockCategory(marker.category) || !Array.isArray(marker.fields)) return null;
  const fields = marker.fields.filter((field) => MATURE_LOCK_FIELDS.includes(field));
  if (!fields.length) return null;
  if (marker.textHash !== autoNsfwTextHash(model.name, model.description)) return null;

  return { reason: { fields, category: marker.category }, at };
}

type MatureLockDb = Pick<typeof dbRead, 'appeal' | 'ratingReview'>;

/**
 * What the model's owner is told about a mature lock the text filter set: the field(s) and a fixed
 * category, never the matched text or the filter's scores. Null for anyone but the owner, and once a
 * lock review naming nsfw, a rating review or a logged moderator nsfw action came since the lock:
 * the owner then sees the outcome only.
 */
export async function getMatureLockReason({
  model,
  viewerId,
  db = dbRead,
}: {
  model: MatureLockSubject;
  viewerId: number | undefined;
  db?: MatureLockDb;
}): Promise<MatureLockReason | null> {
  if (!viewerId || viewerId !== model.userId) return null;
  const stored = storedMatureLockReason(model);
  if (!stored) return null;

  const [systemLock, lockReviews, ratingReview] = await Promise.all([
    // Not every moderator path that touches nsfw drops the marker; its logged activity says so.
    hasSystemNsfwLock(model.id, {
      nsfw: !!model.nsfw,
      lockedProperties: model.lockedProperties?.filter(isDefined) ?? null,
      meta: model.meta,
    }),
    db.appeal.findMany({
      where: {
        entityType: EntityType.Model,
        entityId: model.id,
        resolvedAt: { gte: stored.at },
        context: { path: ['kind'], equals: LOCK_REVIEW_KIND },
      },
      select: { context: true },
    }),
    db.ratingReview.findFirst({
      where: { entityType: 'Model', entityId: model.id, resolvedAt: { gte: stored.at } },
      select: { id: true },
    }),
  ]);
  if (!systemLock || ratingReview) return null;
  if (lockReviews.some((row) => parseLockReviewContext(row.context)?.locks.includes('nsfw')))
    return null;
  return stored.reason;
}
