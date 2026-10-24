import { relativeTime } from './format';
import { reportCountKey, reportEntities } from './reports';

// Retool's `thresholds` and `colors` Functions from Moderation Status, recovered from the raw export.
//
// This is an OPERATING STANDARD, not a rendering detail: it encodes how big each queue is allowed to
// get before it counts as neglected, and the numbers differ by two orders of magnitude between queues
// (2 comment reports is amber; 200 tags is still green). It appears in no query — it lived only in the
// board's colour expression, which is why porting the counts without it lost the whole judgement.
//
// Each list is DESCENDING and read as "the first threshold this count reaches or exceeds", so index 0
// is the worst state. A count below the last entry has no colour — the queue is clear.
const THRESHOLDS: Record<string, readonly number[]> = {
  minors: [1000, 700, 400, 200, 0],
  minorsRescan: [200, 100, 40, 10, 0],
  poi: [300, 200, 150, 100, 0],
  poiRescan: [200, 100, 40, 10, 0],
  blockedTags: [300, 200, 150, 100, 0],
  newUsers: [100, 60, 40, 20, 0],
  reportedImages: [300, 200, 100, 50, 0],
  csam: [10, 6, 4, 2, 0],
  tags: [99999, 200, 100, 50, 0],
  ratings: [400, 300, 200, 100, 0],
  models: [35, 25, 15, 5, 0],
  comments: [2, 2, 1, 1, 0],
  commentV2: [2, 2, 1, 1, 0],
  reviews: [2, 2, 1, 1, 0],
  articles: [2, 2, 1, 1, 0],
  posts: [20, 10, 5, 3, 0],
  users: [20, 10, 5, 3, 0],
  collections: [2, 2, 1, 1, 0],
  bounties: [2, 2, 1, 1, 0],
  bountyEntries: [2, 2, 1, 1, 0],
  chats: [2, 2, 1, 1, 0],
  comics: [2, 2, 1, 1, 0],
  modelsReview: [5, 4, 3, 2, 0],
  // The task-side scales. Dropped on the first pass, which left `articles` — a REPORT scale — as the
  // only key matching the articles backlog, so an informational queue rendered permanent red.
  frontPageSfw: [7000, 5000, 3000, 1000, 0],
  frontPagePG13: [5000, 3000, 1000, 300, 0],
  bountyTask: [5, 4, 3, 2, 0],
  articleTask: [5, 4, 3, 2, 0],
  modelTask: [40, 30, 20, 10, 0],
  unverifiedMutes: [20, 15, 10, 5, 0],
  blockedImages: [50, 40, 25, 10, 0],
  civitaiModels: [2, 2, 1, 1, 0],
  trainingData: [2, 2, 1, 1, 0],
  urgent: [5, 4, 1, 1, 0],
  errors: [30, 20, 10, 5, 0],
  articleReviews: [30, 20, 10, 5, 0],
  // Ours, not Retool's: pending scam restrictions. A first cut, set 2026-10; move it once the queue's
  // working level is known.
  scamRestrictions: [200, 100, 50, 20, 0],
  // Ours, not Retool's: a healthy pipeline holds 0.
  stuckIngestion: [200, 50, 10, 1, 0],
  // Overdue rows only — never queue DEPTH, which is large and healthy for the types that hold rows on
  // purpose. A first cut, unlike the scales above: nothing has been observed stuck long enough to say
  // where the steps belong, so treat these as provisional and move them once a real incident sizes one.
  jobQueueOverdue: [1000, 200, 50, 1, 0],
};

/** Retool's five-step scale, worst first. Tailwind rather than its hex, so the palette stays ours. */
const SEVERITY = [
  'text-red-400',
  'text-orange-400',
  'text-yellow-300',
  'text-lime-300',
  'text-green-400',
] as const;

// Our `countKey`s were named independently of Retool's threshold keys, so the mapping is explicit.
// Anything absent here has no operating standard and renders without a colour — guessing an alias
// would apply the wrong scale, and the scales differ by two orders of magnitude between queues.
const COUNT_KEY_ALIASES: Record<string, string> = {
  // `articles` is the article-REPORT scale ([2,2,1,1,0]). The nav's `articles` key is the unpublished
  // backlog, which Retool scored with `articleTask`; without this alias the fallthrough put a
  // two-is-critical scale on a queue whose own nav entry says nobody works through it.
  articles: 'articleTask',
  // Same trap as `articles`, one level down: the bare `bounties` scale is the bounty-REPORT one that
  // `report:bounty` resolves to, where 2 is critical. The sweep task of the same name counts bounties
  // published since the last claim, which is a workload, so it takes `bountyTask`. Aliases resolve
  // once, so `report:bounty` -> `bounties` is unaffected by this entry.
  bounties: 'bountyTask',
  ratingReviews: 'articleReviews',
  ingestionErrors: 'errors',
  minor: 'minors',
  tag: 'blockedTags',
  imageTags: 'tags',
  imageRatings: 'ratings',
  newUser: 'newUsers',
  'report:image': 'reportedImages',
  'report:model': 'models',
  'report:comment': 'comments',
  'report:commentV2': 'commentV2',
  'report:resourceReview': 'reviews',
  'report:article': 'articles',
  'report:post': 'posts',
  'report:reportedUser': 'users',
  'report:collection': 'collections',
  'report:bounty': 'bounties',
  'report:bountyEntry': 'bountyEntries',
  'report:chat': 'chats',
  'report:comicProject': 'comics',
};

/**
 * The class for a queue's count, or `null` when the queue has no standard — an unknown key must render
 * plainly rather than borrow another queue's scale, since the scales are not comparable.
 */
export function queueSeverityClass(key: string, count: number | null): string | null {
  const rank = queueSeverityRank(key, count);
  return rank === null ? null : SEVERITY[rank];
}

/** The yellow step: a queue at this rank or worse (lower) is over its threshold and wants a moderator. */
export const URGENT_SEVERITY_RANK = 2;

export const severityClassForRank = (rank: number | null): string | null =>
  rank === null ? null : SEVERITY[rank] ?? null;

/** `queueSeverityClass` as a number, 0 worst: for ranking queues against each other. */
export function queueSeverityRank(key: string, count: number | null): number | null {
  const steps = THRESHOLDS[COUNT_KEY_ALIASES[key] ?? key];
  if (!steps || count === null) return null;
  return severityIndex(steps, count);
}

/** The first of `steps` (descending, worst first) that `value` reaches. */
const severityIndex = (steps: readonly number[], value: number): number | null => {
  const index = steps.findIndex((threshold) => value >= threshold);
  return index === -1 ? null : index;
};

export const hasQueueThreshold = (key: string) => (COUNT_KEY_ALIASES[key] ?? key) in THRESHOLDS;

/** How far back the last-actioned lookup looks. Nothing inside it reads as the worst step. */
export const LAST_ACTIONED_WINDOW_DAYS = 7;

/** Hours since a moderator last actioned a queue, read like `THRESHOLDS`: descending, worst first. */
const LAST_ACTIONED_HOURS = [72, 24, 6, 1, 0] as const;

/**
 * The queues the last-actioned lookup covers (`getReportLastActioned`). For these, no time means nobody
 * acted inside the window; for every other queue it means there is no source to ask.
 */
const LAST_ACTIONED_KEYS: ReadonlySet<string> = new Set(reportEntities.map(reportCountKey));

export const tracksLastActioned = (countKey: string | undefined): countKey is string =>
  !!countKey && LAST_ACTIONED_KEYS.has(countKey);

/**
 * The "last actioned" badge for a queue, coloured by the steps above. `at` is absent when nothing was
 * actioned inside the window. `null` for a queue the lookup does not cover, and for one with no recent
 * action and nothing waiting: an empty queue needs nobody, so a red badge there would only be noise.
 */
export function lastActionedBadge(
  countKey: string | undefined,
  at: string | undefined,
  count: number | null,
  now = Date.now()
): { at?: string; class: string; title: string } | null {
  if (!tracksLastActioned(countKey)) return null;
  if (!at) {
    return count
      ? { class: SEVERITY[0], title: `No moderator action in ${LAST_ACTIONED_WINDOW_DAYS} days` }
      : null;
  }
  return { at, class: ageSeverityClass(at, now), title: `Last actioned ${relativeTime(at)}` };
}

/** How stale a "last worked" time is, on the `LAST_ACTIONED_HOURS` steps. */
export function ageSeverityClass(at: string, now = Date.now()): string {
  // Clamped: a server clock ahead of the browser's would put a fresh action in the future.
  const hours = Math.max(0, (now - new Date(at).getTime()) / 3_600_000);
  return SEVERITY[severityIndex(LAST_ACTIONED_HOURS, hours)!];
}

/**
 * What makes one piece of content urgent rather than merely reported: Retool's board carried an
 * "Urgent Content" banner for a pile-up on a single recent item, which is a different fact from a
 * queue being long — one image drawing five complaints in a week is a live incident, and it was
 * previously visible only by scrolling to the Most reported table and reading the counts.
 *
 * Lives here with the other operating standards so the number is changed in one place, deliberately.
 */
export const URGENT_REPORT_COUNT = 5;

/** An item waiting longer than this is overdue: the age at which a queue item's badge turns red. */
export const OVERDUE_ITEM_DAYS = 7;

export const isOverdue = (since: Date | string, now = Date.now()): boolean =>
  now - new Date(since).getTime() > OVERDUE_ITEM_DAYS * 86_400_000;
