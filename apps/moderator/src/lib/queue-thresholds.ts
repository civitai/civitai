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
  minor: 'minors',
  tag: 'blockedTags',
  imageTags: 'tags',
  imageRatings: 'ratings',
  newUser: 'newUsers',
  reported: 'reportedImages',
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
  const steps = THRESHOLDS[COUNT_KEY_ALIASES[key] ?? key];
  if (!steps || count === null) return null;
  const index = steps.findIndex((threshold) => count >= threshold);
  return index === -1 ? null : SEVERITY[index] ?? null;
}

export const hasQueueThreshold = (key: string) => (COUNT_KEY_ALIASES[key] ?? key) in THRESHOLDS;
