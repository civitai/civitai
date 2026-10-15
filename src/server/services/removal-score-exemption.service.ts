import { chunk } from 'lodash-es';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { withoutReversed } from '~/server/services/creator-removals.service';
import {
  REMOVAL_RESTORED_EVENT,
  REPORTS_AGAINST_EVENT,
} from '~/shared/constants/creator-journey.constants';

/**
 * A rule that took effect at `cutoff`: an image uploaded before it (`id <= maxImageId`) and first
 * removed at or after it was judged by the new rule, not the one it was posted under. Only the first
 * removal counts for that: an image removed, restored and removed again was judged under the first.
 */
export type PolicyChangeRule = { cutoff: Date; maxImageId: number; ratings: NsfwRating[] };

/** The image ratings a removal records. */
export const NSFW_RATINGS = ['None', 'Soft', 'Mature', 'X'] as const;
export type NsfwRating = (typeof NSFW_RATINGS)[number];

/** One counted removal of an image, with what its first removal recorded. Times in unix seconds. */
export type RemovalHistory = {
  imageId: number;
  ownerId: number;
  removedAt: number;
  firstRemovedAt: number;
  firstNsfw: string;
  firstReason: string;
  lastReason: string;
  resourceIds: number[];
};

export const exemptionReason = (rule: PolicyChangeRule, label: string) =>
  `${label} cutoff=${rule.cutoff.toISOString()} maxImageId=${
    rule.maxImageId
  } ratings=${rule.ratings.join(',')}`;

const toSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * ClickHouse narrows to counted removals of images the rule could cover; `isPolicyChangeRemoval` is
 * the rule. It must never be stricter than the rule, or the rule cannot see what it drops.
 */
export const policyChangeCandidatesQuery = (rule: PolicyChangeRule) => `
  SELECT ownerId, imageId,
    toUnixTimestamp(maxIf(time, type = '${REPORTS_AGAINST_EVENT}')) AS removedAt,
    toUnixTimestamp(minIf(time, type = '${REPORTS_AGAINST_EVENT}')) AS firstRemovedAt,
    toString(argMinIf(nsfw, time, type = '${REPORTS_AGAINST_EVENT}')) AS firstNsfw,
    argMinIf(ifNull(tosReason, ''), time, type = '${REPORTS_AGAINST_EVENT}') AS firstReason,
    argMaxIf(ifNull(tosReason, ''), time, type = '${REPORTS_AGAINST_EVENT}') AS lastReason,
    groupUniqArrayArrayIf(resources, type = '${REPORTS_AGAINST_EVENT}') AS resourceIds
  FROM images
  WHERE type IN ('${REPORTS_AGAINST_EVENT}', '${REMOVAL_RESTORED_EVENT}')
    AND imageId <= ${rule.maxImageId}
  GROUP BY ownerId, imageId
  HAVING removedAt > toUnixTimestamp(maxIf(time, type = '${REMOVAL_RESTORED_EVENT}'))
    AND firstRemovedAt >= ${toSeconds(rule.cutoff)}
    AND firstNsfw IN (${rule.ratings.map((r) => `'${r}'`).join(', ')})
`;

/**
 * POI-linked (a removal reasoned `poi`, or a resource from a model now flagged POI), uploaded before
 * the rule, first removed after it, and rated one of `ratings` at that first removal: ratings the
 * earlier rules allowed for real people, so the image was within the rules when posted.
 */
export function isPolicyChangeRemoval(
  removal: RemovalHistory,
  rule: PolicyChangeRule,
  poiVersionIds: Set<number>
) {
  if (Number(removal.imageId) > rule.maxImageId) return false;
  if (Number(removal.firstRemovedAt) < toSeconds(rule.cutoff)) return false;
  if (!(rule.ratings as string[]).includes(removal.firstNsfw)) return false;
  return (
    removal.firstReason === 'poi' ||
    removal.lastReason === 'poi' ||
    removal.resourceIds.some((id) => poiVersionIds.has(Number(id)))
  );
}

export async function getPoiVersionIds(pg: AugmentedPool) {
  const query = await pg.cancellableQuery<{ id: number }>(
    `SELECT mv.id FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId" WHERE m.poi`
  );
  return new Set((await query.result()).map((r) => Number(r.id)));
}

/**
 * Counted removals the rule covers and nothing yet reverses: an appeal-reversed or already-exempt
 * removal is left out, so a re-run with the same inputs finds nothing new.
 */
export async function findPolicyChangeRemovals(
  ch: CustomClickHouseClient,
  pg: AugmentedPool,
  rule: PolicyChangeRule
) {
  const candidates = await ch.$query<RemovalHistory>(policyChangeCandidatesQuery(rule));
  const poiVersionIds = await getPoiVersionIds(pg);
  return withoutReversed(candidates.filter((r) => isPolicyChangeRemoval(r, rule, poiVersionIds)));
}

/**
 * Owners whose score total, raised by `pointsPerRemoval` per exempted removal, reaches a score tier
 * it has not: each owner counted once, at the highest tier newly reached.
 */
export async function previewTierUps(
  pg: AugmentedPool,
  removalsByOwner: Map<number, number>,
  pointsPerRemoval: number
) {
  const tiers = await pg
    .cancellableQuery<{ name: string; threshold: number }>(
      `SELECT name, threshold FROM "CreatorMilestone"
       WHERE track = 'score' AND threshold IS NOT NULL ORDER BY threshold DESC`
    )
    .then((q) => q.result());
  const tierUps: Record<string, number> = {};
  let owners = 0;
  for (const ids of chunk([...removalsByOwner.keys()], 10_000)) {
    const totals = await pg
      .cancellableQuery<{ id: number; total: number | null }>(
        `SELECT id, (meta->'scores'->>'total')::numeric AS total FROM "User" WHERE id = ANY($1::int[])`,
        [ids]
      )
      .then((q) => q.result());
    for (const { id, total } of totals) {
      const before = Number(total ?? 0);
      const after = before + (removalsByOwner.get(Number(id)) ?? 0) * pointsPerRemoval;
      const reached = tiers.find((t) => before < t.threshold && after >= t.threshold);
      if (!reached) continue;
      owners++;
      tierUps[reached.name] = (tierUps[reached.name] ?? 0) + 1;
    }
  }
  return { owners, byTier: tierUps };
}

export async function insertRemovalScoreExemptions(
  pg: AugmentedPool,
  imageIds: number[],
  reason: string,
  createdBy: number | null
) {
  let inserted = 0;
  for (const ids of chunk(imageIds, 1000)) {
    const rows = await pg
      .cancellableQuery<{ imageId: number }>(
        `INSERT INTO "RemovalScoreExemption" ("imageId", reason, "createdBy")
         SELECT unnest($1::int[]), $2, $3
         ON CONFLICT ("imageId") DO NOTHING
         RETURNING "imageId"`,
        [ids, reason, createdBy]
      )
      .then((q) => q.result());
    inserted += rows.length;
  }
  return inserted;
}
