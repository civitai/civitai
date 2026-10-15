import { chunk } from 'lodash-es';
import * as z from 'zod';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { withoutReversed } from '~/server/services/creator-removals.service';
import { NsfwLevelDeprecated } from '~/shared/constants/browsingLevel.constants';
import {
  REMOVAL_RESTORED_EVENT,
  REPORTS_AGAINST_EVENT,
} from '~/shared/constants/creator-journey.constants';
import {
  booleanString,
  commaDelimitedEnumArray,
  commaDelimitedNumberArray,
} from '~/utils/zod-helpers';

/**
 * A rule that took effect at `cutoff`. An image uploaded before it (`id <= maxImageId`) and first
 * removed at or after it was judged by the new rule, not the one it was posted under. Only the first
 * removal counts for that: an image removed, restored and removed again was judged under the first.
 */
export type PolicyChangeRule = {
  cutoff: Date;
  maxImageId: number;
  ratings: `${NsfwLevelDeprecated}`[];
  requireFirstRemovalAfterCutoff: boolean;
};

// `Blocked` is never a rating an image was posted within the rules at.
const EXEMPTIBLE_RATINGS = Object.values(NsfwLevelDeprecated).filter(
  (r) => r !== NsfwLevelDeprecated.Blocked
);

/** The backfill route's params. Defaults are the real-people policy article. */
export const backfillExemptionParams = z.object({
  cutoff: z.coerce.date().default(new Date('2025-05-22T22:02:27Z')),
  maxImageId: z.coerce.number().int().positive().default(77_895_843),
  requireFirstRemovalAfterCutoff: booleanString().default(true),
  ratings: commaDelimitedEnumArray(EXEMPTIBLE_RATINGS)
    .refine((ratings) => ratings.length > 0)
    .default([NsfwLevelDeprecated.None]),
  label: z
    .string()
    .regex(/^[\w-]{1,40}$/)
    .default('poi-policy'),
  createdBy: z.coerce.number().int().positive().optional(),
  probe: commaDelimitedNumberArray().optional(),
  dryRun: booleanString().default(true),
});

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
  minorRemovals: number;
};

export const exemptionReason = (rule: PolicyChangeRule, label: string) =>
  `${label} cutoff=${rule.cutoff.toISOString()} maxImageId=${
    rule.maxImageId
  } ratings=${rule.ratings.join(',')} requireFirstRemovalAfterCutoff=${
    rule.requireFirstRemovalAfterCutoff
  }`;

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
    groupUniqArrayArrayIf(resources, type = '${REPORTS_AGAINST_EVENT}') AS resourceIds,
    countIf(type = '${REPORTS_AGAINST_EVENT}' AND tosReason = 'minor') AS minorRemovals
  FROM images
  WHERE type IN ('${REPORTS_AGAINST_EVENT}', '${REMOVAL_RESTORED_EVENT}')
    AND imageId <= ${rule.maxImageId}
  GROUP BY ownerId, imageId
  HAVING removedAt > toUnixTimestamp(maxIf(time, type = '${REMOVAL_RESTORED_EVENT}'))${
  rule.requireFirstRemovalAfterCutoff ? `\n    AND firstRemovedAt >= ${toSeconds(rule.cutoff)}` : ''
}
    AND firstNsfw IN (${rule.ratings.map((r) => `'${r}'`).join(', ')})
`;

/**
 * Uploaded before the rule, never removed as `minor`, rated one of `ratings` at its first removal,
 * and POI-linked: a `poi` reason on the first or latest removal, or, when first removed after the
 * cutoff, a resource from a model now flagged POI. With `requireFirstRemovalAfterCutoff` on, an
 * image first removed before the cutoff is never covered.
 */
export function isPolicyChangeRemoval(
  removal: RemovalHistory,
  rule: PolicyChangeRule,
  poiVersionIds: Set<number>
) {
  if (Number(removal.imageId) > rule.maxImageId) return false;
  if (Number(removal.minorRemovals) > 0) return false;
  if (!(rule.ratings as string[]).includes(removal.firstNsfw)) return false;
  const poiReason = removal.firstReason === 'poi' || removal.lastReason === 'poi';
  if (Number(removal.firstRemovedAt) < toSeconds(rule.cutoff))
    return !rule.requireFirstRemovalAfterCutoff && poiReason;
  return poiReason || removal.resourceIds.some((id) => poiVersionIds.has(Number(id)));
}

export async function getPoiVersionIds(pg: AugmentedPool) {
  const query = await pg.cancellableQuery<{ id: number }>(
    `SELECT mv.id FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId" WHERE m.poi`
  );
  return new Set((await query.result()).map((r) => Number(r.id)));
}

/**
 * Counted removals the rule covers, of images with no exemption yet and no appeal reversing them.
 * An image already exempted is left out even when removed again since: its row cannot be replaced.
 */
export async function findPolicyChangeRemovals(
  ch: CustomClickHouseClient,
  pg: AugmentedPool,
  rule: PolicyChangeRule
) {
  const candidates = await ch.$query<RemovalHistory>(policyChangeCandidatesQuery(rule));
  const poiVersionIds = await getPoiVersionIds(pg);
  const matched = candidates.filter((r) => isPolicyChangeRemoval(r, rule, poiVersionIds));
  const exempt = new Set<number>();
  for (const ids of chunk(
    matched.map((r) => Number(r.imageId)),
    10_000
  )) {
    const rows = await pg
      .cancellableQuery<{ imageId: number }>(
        `SELECT "imageId" FROM "RemovalScoreExemption" WHERE "imageId" = ANY($1::int[])`,
        [ids]
      )
      .then((q) => q.result());
    for (const { imageId } of rows) exempt.add(Number(imageId));
  }
  return withoutReversed(matched.filter((r) => !exempt.has(Number(r.imageId))));
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
       WHERE track = 'score' AND threshold IS NOT NULL`
    )
    .then((q) => q.result())
    .then((rows) => rows.sort((a, b) => b.threshold - a.threshold));
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
