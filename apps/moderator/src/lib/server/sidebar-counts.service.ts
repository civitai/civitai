import { sql } from '@civitai/db/kysely';
import { NsfwLevel } from '@civitai/shared';
import { APPS_PLATFORM_FEEDBACK_AREA } from '@civitai/shared/feedback.constants';
import { createCache } from './cache';
import { dbRead } from './db';
import { bounded } from './bounded';
import { getImageReviewCounts } from './image-review.service';
import { countStuckIngestion, countIngestionErrorImages } from './ingestion.service';
import { getImageRatingReviewCount } from './image-rating-review.service';
import { countModeratorArticles } from './articles.service';
import { getRatingReviewCounts } from './rating-reviews.service';
import { getReportCounts } from './reports.service';
import { countNewFeedback } from './feedback.service';
import { countRemovedAppeals } from './removed-appeals.service';
import { countSiteAppeals } from './site-appeals.service';
import { siteAppealCountKey } from '$lib/site-appeals';
import { SITE_APPEAL_CATEGORIES } from '@civitai/shared/site-appeal';
import { countStrikeReview } from './strike-review.service';
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

const counts = createCache({ name: 'sidebar-counts:v1', fetch: fetchCounts, ttlSeconds: 60 });

/**
 * The file-match counts for Needs review's badge, waited on for a second at most. Every verdict busts
 * their cache and a fill takes ~10s, so a wait alone blanked the badge after each ruling. Until a fill
 * lands, the badge shows the last counts this process saw: stale by the verdicts since, not missing.
 * A failed fill drops it, since a failure can last.
 */
let lastMinorQueue: MinorQueueCounts | null = null;
async function minorQueueCounts(): Promise<MinorQueueCounts | null> {
  const fill = getMinorQueueCounts();
  // A fill that outlives the wait still lands here (or clears it), so the next refresh has it.
  fill.then(
    (c) => (lastMinorQueue = c),
    () => (lastMinorQueue = null)
  );
  let failed = false;
  const fresh = await bounded(
    () => fill,
    1_000,
    () => (failed = true)
  );
  if (failed) return (lastMinorQueue = null);
  return fresh ?? lastMinorQueue;
}

export function getSidebarCounts(): Promise<SidebarCounts> {
  return counts.get({});
}

async function fetchCounts(): Promise<SidebarCounts> {
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
    minorQueueCounts(),
    // The page's own facet query, so the badge always equals the queue's "All" total.
    getMinorFlagAppealGroups({}),
    // Auto-flagged's own total, in models: the badge equals the queue's "of N". The hash branch scans
    // "Model" (no index serves its predicate), so it is bounded; a failure drops only this badge.
    bounded(() => getFlaggedCount()),
    // Needs review's held detections, in models (`Model_textScanRedetected_idx`).
    bounded(getHeldDetectionModelCount),
    // Bounded until `User_strikeReview_idx` exists: without it this scans every muted account.
    bounded(countStrikeReview),
    bounded(countPendingCsamHolds),
    // One grouped count over the partial queue index for all four queues; bounded so a failure drops
    // only these badges.
    bounded(countSiteAppeals),
    // Bounded: the view aggregates every hold row, so no index serves it.
    bounded(() => countEvidenceHoldsEnding(dbRead)),
  ]);
  return {
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
    ...(flaggedModels != null ? { modelFlagsAuto: flaggedModels } : {}),
    ...needsReviewCounts(heldDetectionModels, minorQueue),
    ...(siteAppeals != null
      ? Object.fromEntries(
          SITE_APPEAL_CATEGORIES.map((c) => [siteAppealCountKey(c), siteAppeals[c]])
        )
      : {}),
    ...(strikeReview != null ? { strikeReview } : {}),
    ...(csamTextHolds != null ? { csamTextHolds } : {}),
    ...(evidenceHoldsEnding != null ? { evidenceHoldsEnding: evidenceHoldsEnding.owners } : {}),
    ...(stuckIngestion != null ? { stuckIngestion } : {}),
    ...(ingestionErrors != null ? { ingestionErrors } : {}),
  };
}

/**
 * Needs review's badge per combination of the kinds a viewer may rule (the nav picks the key; see
 * `needsReviewCountKey`), each in models: a model with a held detection and a file match is one row
 * and counts once. A model waiting in two tabs (Appeals and Auto-flagged, say) still counts in each.
 */
function needsReviewCounts(
  detections: number | null | undefined,
  matches: { pending: number; pendingWithDetection: number } | null | undefined
): SidebarCounts {
  const parts = {
    detections: detections ?? null,
    matches: matches?.pending ?? null,
    overlap: matches?.pendingWithDetection ?? null,
  };
  const out: SidebarCounts = {};
  const keys = [
    [NEEDS_REVIEW_COUNT_KEYS.all, { detections: true, matches: true }],
    [NEEDS_REVIEW_COUNT_KEYS.detections, { detections: true, matches: false }],
    [NEEDS_REVIEW_COUNT_KEYS.matches, { detections: false, matches: true }],
  ] as const;
  for (const [key, granted] of keys) {
    const total = needsReviewTotal(granted, parts);
    if (total !== null) out[key] = total;
  }
  return out;
}
