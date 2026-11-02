import { Prisma } from '@prisma/client';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { excludedRecord } from '~/server/jobs/appeal-decision-records';
import {
  type CreatorRemoval,
  removalWindowStart,
  removalsQuery,
  withoutReversed,
} from '~/server/services/creator-removals.service';
import {
  getAppealExcludedIds,
  getHoldMarkerBlockedImageIds,
} from '~/server/services/report.service';
import { ZERO_WEIGHT_REASONS } from '~/shared/utils/creator-removal-weights';
import { getAppealRefusal, isAppealableImage } from '~/shared/utils/appeal';
import { type AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

/** One fixed wording, matching the removal notification. */
export const REMOVAL_REASON = 'Terms of Service violation';
export const REMOVED_IMAGES_LIMIT = 1000;
const CLICKHOUSE_TIMEOUT_SECONDS = 10;

export type RemovedImage = {
  removedAt: Date;
  reason: string;
  /** Set only while the member's image still exists; a purged one has nothing to link to. */
  imageId: number | null;
  canAppeal: boolean;
};

const sqlString = (value: string) => `'${value.replace(/['\\]/g, '\\$&')}'`;

/**
 * The owner's removals that cost points, in ClickHouse so the limit applies to those alone: made
 * after `windowStart` (unix seconds) and of a reason that weighs something. A removal with no
 * reason weighs the full amount.
 */
export const REMOVALS_QUERY = `${removalsQuery('ownerId = {userId:Int32}')}
    AND removedAt > {windowStart:Int64}${
      ZERO_WEIGHT_REASONS.length
        ? `
    AND trimBoth(ifNull(reason, '')) NOT IN (${ZERO_WEIGHT_REASONS.map(sqlString).join(', ')})`
        : ''
    }
  ORDER BY removedAt DESC
  LIMIT ${REMOVED_IMAGES_LIMIT}
`;

async function getRemovalEvents(userId: number, now: Date) {
  if (!clickhouse) return [];
  // The shared client waits minutes for a stalled connection; the page should not.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (CLICKHOUSE_TIMEOUT_SECONDS + 1) * 1000);
  try {
    const response = await clickhouse.query({
      query: REMOVALS_QUERY,
      query_params: { userId, windowStart: Math.floor(removalWindowStart(now).getTime() / 1000) },
      format: 'JSONEachRow',
      abort_signal: controller.signal,
      clickhouse_settings: { max_execution_time: CLICKHOUSE_TIMEOUT_SECONDS },
    });
    return (await response.json()) as CreatorRemoval[];
  } finally {
    clearTimeout(timer);
  }
}

type ImageState = {
  imageId: number;
  excluded: boolean;
  owned: boolean;
  blockedFor: string | null;
  needsReview: string | null;
};

function getImageStates(userId: number, imageIds: number[]) {
  const r = Prisma.raw('r');
  return dbRead.$queryRaw<ImageState[]>`
    SELECT r."imageId", ${excludedRecord(r)} AS excluded,
      coalesce(i."userId" = ${userId}, false) AS owned, i."blockedFor", i."needsReview"
    FROM (
      SELECT u.id AS "imageId", li."blockedFor"
      FROM unnest(${imageIds}::int[]) AS u(id)
      LEFT JOIN "Image" li ON li.id = u.id
    ) r
    LEFT JOIN "Image" i ON i.id = r."imageId"
  `;
}

async function getLatestAppeals(userId: number, imageIds: number[]) {
  const latest = new Map<number, { status: AppealStatus }>();
  if (!imageIds.length) return latest;
  const appeals = await dbRead.appeal.findMany({
    where: { entityType: EntityType.Image, entityId: { in: imageIds }, userId },
    orderBy: { id: 'desc' },
    select: { entityId: true, status: true },
  });
  for (const appeal of appeals)
    if (!latest.has(appeal.entityId)) latest.set(appeal.entityId, appeal);
  return latest;
}

/**
 * The member's own removed images that currently cost points, newest first, up to the limit (see
 * `REMOVALS_QUERY` for what costs points). Removals the appeal flow excludes are left out too, and `total` counts only what is listed.
 */
export async function getMyRemovedImages(userId: number, now = new Date()) {
  const fetched = await getRemovalEvents(userId, now);
  const events = await withoutReversed(fetched);
  const none = { total: 0, truncated: false, items: [] as RemovedImage[] };
  if (!events.length) return none;

  const imageIds = events.map((e) => Number(e.imageId));
  const [states, excludedIds] = await Promise.all([
    getImageStates(userId, imageIds),
    getAppealExcludedIds({ imageIds, userIds: [userId] }),
  ]);
  if (excludedIds.users.has(userId)) return none;

  const stateById = new Map(states.map((s) => [Number(s.imageId), s]));
  // An image with no state row is left out rather than shown unchecked.
  const listed = events.flatMap((e) => {
    const id = Number(e.imageId);
    const state = stateById.get(id);
    if (!state || state.excluded || excludedIds.images.has(id)) return [];
    return [{ id, removedAt: e.removedAt, state }];
  });

  const existing = listed.filter((e) => e.state.owned).map((e) => e.id);
  // A hold that has ended no longer excludes the owner above, but the images it kept stay refused.
  const [appeals, holdBlocked] = await Promise.all([
    getLatestAppeals(userId, existing),
    getHoldMarkerBlockedImageIds({ imageIds: existing, userId }),
  ]);

  const items: RemovedImage[] = listed.map(({ id, removedAt, state }) => ({
    removedAt: new Date(Number(removedAt) * 1000),
    reason: REMOVAL_REASON,
    imageId: state.owned ? id : null,
    canAppeal:
      state.owned &&
      isAppealableImage(state) &&
      !holdBlocked.has(id) &&
      !getAppealRefusal(EntityType.Image, appeals.get(id)),
  }));
  return { total: items.length, truncated: fetched.length >= REMOVED_IMAGES_LIMIT, items };
}
