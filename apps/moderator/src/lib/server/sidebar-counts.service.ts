import { randomUUID } from 'node:crypto';
import { sql } from '@civitai/db/kysely';
import { NsfwLevel } from '@civitai/shared';
import {
  APPS_PLATFORM_FEEDBACK_AREA,
  ORCHESTRATION_FEEDBACK_AREA,
} from '@civitai/shared/feedback.constants';
import { prefixCacheKey, type RedisKeyTemplateCache } from '@civitai/redis';
import { logToAxiom } from './axiom';
import { createCache } from './cache';
import { dbRead } from './db';
import { bounded } from './bounded';
import { getRedis } from './redis';
import { getImageReviewCounts } from './image-review.service';
import { countStuckIngestion, countIngestionErrorImages } from './ingestion.service';
import { countImageTagsNeedingReview, IMAGE_TAGS_COUNT_TIMEOUT_MS } from './image-tags-count';
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
import { countOpenUnpaidAwards } from './bounty-unpaid-award.service';
import { countTrainingDataReview } from './training-moderation.service';
import {
  getFlaggedCount,
  getHeldDetectionModelCount,
  getMinorFlagAppealGroups,
  getMinorQueueCounts,
  type MinorQueueCounts,
} from './minor-hash.service';
import { ticketSnapshot } from './tickets/snapshot';
import { peekTicketCounts } from './tickets/view-counts';
import { NEEDS_REVIEW_COUNT_KEYS, needsReviewTotal } from '$lib/minor-flags/needs-review';
import { countInquisitorQueue } from './knights/inquisitor.service';
import { countPendingLinkReviews } from './knights/link-review.service';
import { getRestrictedVerdictCount } from './restricted-nsfw-verdicts';

export type SidebarCounts = Record<string, number>;

/** `unavailable`: the keys this fill could not count, so a badge summing them shows it is partial
 *  instead of a smaller total. */
export type SidebarCountsResult = { counts: SidebarCounts; unavailable: string[] };

const counts = createCache({ name: 'sidebar-counts:v3', fetch: fetchCounts, ttlSeconds: 60 });

/** How long a part's last landed value stands in for it; older, the part is unknown. */
export const LAST_GOOD_MS = 15 * 60_000;

const lastGoodKey = (part: string) =>
  prefixCacheKey(`mod:sidebar-counts:last-good:${part}`) as RedisKeyTemplateCache;

const fillLockKey = (part: string) =>
  prefixCacheKey(`mod:sidebar-counts:fill-lock:${part}`) as RedisKeyTemplateCache;

/** Deletes the lock only while it still holds this server's token, so a lock that expired and was taken by another server is not released from under it. */
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;

/**
 * A part of a badge sum, waited on for `ms` at most. A late or failed fill is answered with the last
 * value any server landed in the past `LAST_GOOD_MS`: stale by what changed since, not missing. Null
 * only when there is none. Kept in Redis, not in this process: every server fills the shared counts,
 * so a per-process value made consecutive refreshes disagree (see `cache.ts`).
 *
 * `lockSeconds`: a fill that outlives its wait keeps running (nothing cancels the query), and the
 * counts refill every minute, so a slow part would stack scans. With it, one server at a time runs the
 * fill, holding a Redis lock (set `lockSeconds` longer than the query can run). The lock is released
 * when the fill lands; after a failed fill it is kept until it expires, so a fill that keeps failing is
 * retried every `lockSeconds`, not every minute. A refresh that does not get the lock answers from the
 * last value.
 */
async function withLastGood<T>(
  part: string,
  run: () => Promise<T>,
  ms: number,
  { lockSeconds }: { lockSeconds?: number } = {}
): Promise<T | null> {
  const key = lastGoodKey(part);
  const lock = lockSeconds ? fillLockKey(part) : null;
  const token = randomUUID();
  let fresh: T | null = null;
  const locked =
    lock === null ||
    (await getRedis()
      .set(lock, token, { NX: true, EX: lockSeconds })
      .then((reply) => reply !== null)
      .catch(() => false));
  if (locked) {
    const fill = run();
    // A fill that outlives the wait still lands, so the next refresh has it.
    fill
      .then(
        async (value) => {
          await getRedis()
            .set(key, JSON.stringify({ value, at: Date.now() }), { EX: LAST_GOOD_MS / 1000 })
            .catch(() => undefined);
          if (lock) await getRedis().eval(RELEASE_LOCK, { keys: [lock], arguments: [token] });
        },
        (error: unknown) =>
          void logToAxiom({
            type: 'sidebar-count-fill-failed',
            part,
            message: error instanceof Error ? error.message : String(error),
          }).catch(() => undefined)
      )
      .catch(() => undefined);
    fresh = await bounded(() => fill, ms);
  }
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
    feedbackOrchestrationNew,
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
    knightsInquisitor,
    knightsLinkReviews,
    ticketCounts,
    bountyUnpaidAwards,
    trainingDataReview,
  ] = await Promise.all([
    getImageReviewCounts(),
    // Waited on for 3 seconds at most, and at most one scan runs across all servers: it can take
    // minutes on a large TagsOnImageNew, and every other badge in the fill waits behind it.
    withLastGood('image-tags', countImageTagsNeedingReview, 3_000, {
      lockSeconds: IMAGE_TAGS_COUNT_TIMEOUT_MS / 1000 + 60,
    }),
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
    countNewFeedback(ORCHESTRATION_FEEDBACK_AREA),
    countRemovedAppeals(),
    countPendingRemovalConfirmations(),
    // Waited on for a second at most: every verdict busts their cache and a fill takes ~10s.
    withLastGood('minor-queue', getMinorQueueCounts, 1_000),
    // The page's own facet query, so the badge always equals the queue's "All" total.
    getMinorFlagAppealGroups({}),
    // Auto-flagged's own total, in models: the badge equals the queue's "of N". The hash branch scans
    // "Model" (no index serves its predicate), so it is bounded; a failure drops only this badge.
    bounded(() => getFlaggedCount()),
    // Needs review's held detections, in models (`Model_textScanRedetected_idx`), plus its
    // restricted-verdict leads (`Model_restrictedNsfwVerdict_idx`). A model with both counts twice.
    withLastGood(
      'held-detections',
      async () => {
        const [held, leads] = await Promise.all([
          getHeldDetectionModelCount(),
          getRestrictedVerdictCount(),
        ]);
        return held + leads;
      },
      3_000
    ),
    // Bounded until `User_strikeReview_idx` exists: without it this scans every muted account.
    bounded(countStrikeReview),
    bounded(countPendingScamRestrictions),
    bounded(countPendingCsamHolds),
    // One grouped count over the partial queue index for all four queues; bounded so a failure drops
    // only these badges.
    bounded(countSiteAppeals),
    // Bounded: the view aggregates every hold row, so no index serves it.
    bounded(() => countEvidenceHoldsEnding(dbRead)),
    bounded(countInquisitorQueue),
    bounded(countPendingLinkReviews),
    // Bounded so a slow Redis read cannot hold up the sidebar; these keys are not in `maybe`, so a timeout shows no badge rather than `unavailable`.
    bounded(() => peekTicketCounts(() => ticketSnapshot.peek())),
    // Bounded: the legacy half filters ModActivity on `activity`, which no index covers.
    bounded(countOpenUnpaidAwards),
    // A build reads every Paused version's workflow and the gate ledger, well past a sidebar wait.
    withLastGood('training-data-review', countTrainingDataReview, 3_000),
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
    knightsInquisitor,
    knightsLinkReviews,
    bountyUnpaidAwards,
    imageTags,
    trainingDataReview,
  };
  const unavailable = Object.keys(maybe).filter((key) => maybe[key] == null);
  const known = Object.entries(maybe).filter((e): e is [string, number] => e[1] != null);
  return {
    counts: {
      ...modes,
      ...reports,
      imageRatings,
      appeals: Number(appeals?.count ?? 0),
      articles,
      ratingReviews: ratingReviews.Pending,
      feedbackNew,
      feedbackAppsPlatformNew,
      feedbackOrchestrationNew,
      removedAppeals,
      reRemovals,
      modelFlagsAppeals: modelFlagAppealGroups.reduce((sum, g) => sum + g.count, 0),
      ...Object.fromEntries(known),
      ...ticketCounts,
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
