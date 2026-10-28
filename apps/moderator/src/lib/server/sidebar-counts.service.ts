import { sql } from '@civitai/db/kysely';
import { NsfwLevel } from '@civitai/shared';
import { APPS_PLATFORM_FEEDBACK_AREA } from '@civitai/shared/feedback.constants';
import { prefixCacheKey, type RedisKeyTemplateCache } from '@civitai/redis';
import { createCache } from './cache';
import { dbRead } from './db';
import { bounded } from './bounded';
import { getRedis } from './redis';
import { getImageReviewCounts } from './image-review.service';
import { countStuckIngestion, countIngestionErrorImages } from './ingestion.service';
import { getImageRatingReviewCount } from './image-rating-review.service';
import { countModeratorArticles } from './articles.service';
import { getRatingReviewCounts } from './rating-reviews.service';
import {
  getReportCounts,
  getReportLastActioned,
  getReportOldestOpen,
  type LastActioned,
} from './reports.service';
import { countNewFeedback } from './feedback.service';
import { countRemovedAppeals } from './removed-appeals.service';
import { countSiteAppeals } from './site-appeals.service';
import { siteAppealCountKey } from '$lib/site-appeals';
import { SITE_APPEAL_CATEGORIES } from '@civitai/shared/site-appeal';
import { countStrikeReview } from './strike-review.service';
import { countPendingScamRestrictions } from './user-restriction.service';
import { countPendingCsamHolds } from './csam-holds.queries';
import { countEvidenceHoldsEnding } from '@civitai/db-queries/evidence-hold';
import { countPendingRemovalConfirmations } from './image-removal-confirmation.service';
import {
  getFlaggedCount,
  getHeldDetectionModelCount,
  getMinorFlagAppealGroups,
  getMinorQueueCounts,
  type MinorQueueCounts,
} from './minor-hash.service';
import { NEEDS_REVIEW_COUNT_KEYS, needsReviewTotal } from '$lib/minor-flags/needs-review';

export type SidebarCounts = Record<string, number>;

/** `unavailable`: the keys this fill could not count, so a badge summing them shows it is partial
 *  instead of a smaller total. */
export type SidebarCountsResult = { counts: SidebarCounts; unavailable: string[] };

const counts = createCache({ name: 'sidebar-counts:v3', fetch: fetchCounts, ttlSeconds: 60 });

/** How long a part's last landed value stands in for it; older, the part is unknown. */
export const LAST_GOOD_MS = 15 * 60_000;

const lastGoodKey = (part: string) =>
  prefixCacheKey(`mod:sidebar-counts:last-good:${part}`) as RedisKeyTemplateCache;

/**
 * A part of a badge sum, waited on for `ms` at most. A late or failed fill is answered with the last
 * value any server landed in the past `LAST_GOOD_MS`: stale by what changed since, not missing. Null
 * only when there is none. Kept in Redis, not in this process: every server fills the shared counts,
 * so a per-process value made consecutive refreshes disagree (see `cache.ts`).
 */
async function withLastGood<T>(part: string, run: () => Promise<T>, ms: number): Promise<T | null> {
  const key = lastGoodKey(part);
  const fill = run();
  // A fill that outlives the wait still lands, so the next refresh has it.
  fill
    .then((value) =>
      getRedis().set(key, JSON.stringify({ value, at: Date.now() }), { EX: LAST_GOOD_MS / 1000 })
    )
    .catch(() => undefined);
  const fresh = await bounded(() => fill, ms);
  if (fresh !== null) return fresh;
  try {
    const raw = await getRedis().get(key);
    const last = raw ? (JSON.parse(raw) as { value: T; at: number }) : null;
    return last && Date.now() - last.at <= LAST_GOOD_MS ? last.value : null;
  } catch {
    return null;
  }
}

export function getSidebarCounts(): Promise<SidebarCountsResult> {
  return counts.get({});
}

/** `countKey` → when, and by whom, a moderator last actioned that queue. Only report queues have one yet. */
export type SidebarLastActioned = Record<string, LastActioned>;

const lastActioned = createCache({
  name: 'sidebar-last-actioned:v2',
  fetch: getReportLastActioned,
  ttlSeconds: 60,
});

export function getSidebarLastActioned(): Promise<SidebarLastActioned> {
  return lastActioned.get({});
}

/** `countKey` → ISO time its oldest waiting item arrived. Only report queues have one yet. */
export type QueueOldest = Record<string, string>;

const queueOldest = createCache({
  name: 'queue-oldest:v1',
  fetch: getReportOldestOpen,
  ttlSeconds: 60,
});

export function getQueueOldest(): Promise<QueueOldest> {
  return queueOldest.get({});
}

async function fetchCounts(): Promise<SidebarCountsResult> {
  const [
    modes,
    imageTags,
    imageRatings,
    appeals,
    articles,
    ratingReviews,
    reports,
    stuckIngestion,
    ingestionErrors,
    feedbackNew,
    feedbackAppsPlatformNew,
    removedAppeals,
    reRemovals,
    minorQueue,
    modelFlagAppealGroups,
    flaggedModels,
    heldDetectionModels,
    strikeReview,
    scamRestrictions,
    csamTextHolds,
    siteAppeals,
    evidenceHoldsEnding,
  ] = await Promise.all([
    getImageReviewCounts(),
    // Bitmask predicates must match the TagsOnImageNew_needsReview_idx partial index (bit 9 set, bit 10 clear).
    // The nsfwLevel bound must match the QUEUE's (image-tags.service.ts) — without it, blocked images
    // inflate a badge whose page can never show them, so the count never reaches zero.
    dbRead
      .selectFrom('TagsOnImageNew as toi')
      .innerJoin('Image as i', 'i.id', 'toi.imageId')
      .select((eb) => eb.fn.count('toi.imageId').distinct().as('count'))
      .where(sql<boolean>`((toi.attributes >> 9)::integer & 1) = 1`)
      .where(sql<boolean>`((toi.attributes >> 10)::integer & 1) <> 1`)
      .where('i.nsfwLevel', '<', NsfwLevel.Blocked)
      .executeTakeFirst(),
    getImageRatingReviewCount(),
    dbRead
      .selectFrom('Image')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('needsReview', '=', 'appeal')
      .executeTakeFirst(),
    countModeratorArticles(),
    getRatingReviewCounts(),
    getReportCounts(),
    // Bounded: neither count is served by an index alone; see `bounded`.
    bounded(countStuckIngestion),
    bounded(countIngestionErrorImages),
    // NOT bounded: a count over a small table the producer can only grow five rows per user per
    // hour, behind the 60-second cache (plan shape varies with size and vacuum state; see
    // `countNewFeedback`). Wrapping it in a 3-second race would add a timer and a nullable to buy
    // nothing.
    countNewFeedback(),
    countNewFeedback(APPS_PLATFORM_FEEDBACK_AREA),
    countRemovedAppeals(),
    countPendingRemovalConfirmations(),
    // Waited on for a second at most: every verdict busts their cache and a fill takes ~10s.
    withLastGood('minor-queue', getMinorQueueCounts, 1_000),
    // The page's own facet query, so the badge always equals the queue's "All" total.
    getMinorFlagAppealGroups({}),
    // Auto-flagged's own total, in models: the badge equals the queue's "of N". The hash branch scans
    // "Model" (no index serves its predicate), so it is bounded; a failure drops only this badge.
    bounded(() => getFlaggedCount()),
    // Needs review's held detections, in models (`Model_textScanRedetected_idx`).
    withLastGood('held-detections', getHeldDetectionModelCount, 3_000),
    // Bounded until `User_strikeReview_idx` exists: without it this scans every muted account.
    bounded(countStrikeReview),
    bounded(countPendingScamRestrictions),
    bounded(countPendingCsamHolds),
    // One grouped count over the partial queue index for all four queues; bounded so a failure drops
    // only these badges.
    bounded(countSiteAppeals),
    // Bounded: the view aggregates every hold row, so no index serves it.
    bounded(() => countEvidenceHoldsEnding(dbRead)),
  ]);
  // Null where a bounded count did not answer.
  const maybe: Record<string, number | null> = {
    modelFlagsAuto: flaggedModels,
    ...needsReviewCounts(heldDetectionModels, minorQueue),
    ...Object.fromEntries(
      SITE_APPEAL_CATEGORIES.map((c) => [siteAppealCountKey(c), siteAppeals?.[c] ?? null])
    ),
    strikeReview,
    scamRestrictions,
    csamTextHolds,
    evidenceHoldsEnding: evidenceHoldsEnding?.owners ?? null,
    stuckIngestion,
    ingestionErrors,
  };
  const unavailable = Object.keys(maybe).filter((key) => maybe[key] == null);
  const known = Object.entries(maybe).filter((e): e is [string, number] => e[1] != null);
  return {
    counts: {
      ...modes,
      ...reports,
      imageTags: Number(imageTags?.count ?? 0),
      imageRatings,
      appeals: Number(appeals?.count ?? 0),
      articles,
      ratingReviews: ratingReviews.Pending,
      feedbackNew,
      feedbackAppsPlatformNew,
      removedAppeals,
      reRemovals,
      modelFlagsAppeals: modelFlagAppealGroups.reduce((sum, g) => sum + g.count, 0),
      ...Object.fromEntries(known),
    },
    unavailable,
  };
}

/**
 * Needs review's badge per combination of the kinds a viewer may rule (the nav picks the key; see
 * `needsReviewCountKey`), each in models: a model with a held detection and a file match is one row
 * and counts once. A model waiting in two tabs (Appeals and Auto-flagged, say) still counts in each.
 */
function needsReviewCounts(
  detections: number | null | undefined,
  matches: MinorQueueCounts | null | undefined
): Record<string, number | null> {
  const parts = {
    detections: detections ?? null,
    matches: matches?.pending ?? null,
    overlap: matches?.pendingWithDetection ?? null,
  };
  const keys = [
    [NEEDS_REVIEW_COUNT_KEYS.all, { detections: true, matches: true }],
    [NEEDS_REVIEW_COUNT_KEYS.detections, { detections: true, matches: false }],
    [NEEDS_REVIEW_COUNT_KEYS.matches, { detections: false, matches: true }],
  ] as const;
  return Object.fromEntries(keys.map(([key, granted]) => [key, needsReviewTotal(granted, parts)]));
}
