/**
 * Every creator milestone the code can grant, keyed by its CreatorMilestone key. Names, thresholds,
 * hints and cosmetics live on the row; this says which detector grants the key, with what params,
 * and from when a grant is announced. A definition achieved before its launchedAt is granted
 * silently, so shipping a new one backfills existing qualifiers without a notification flood.
 *
 * Keys are permanent: renaming one re-grants everyone under the new key.
 */

import { SCORE_TIERS, scoreTierKey } from '~/shared/constants/creator-journey.constants';

export const PUBLISHED_ENTITIES = ['model', 'article'] as const;
export const USER_METRICS = ['followerCount', 'reactionCount'] as const;

type DetectorParams = {
  // Thresholds stay on the CreatorMilestone rows, so the score detector takes none.
  scoreSnapshot: Record<string, never>;
  publishedCount: { entity: (typeof PUBLISHED_ENTITIES)[number] };
  modelDownloads: Record<string, never>;
  userMetric: { metric: (typeof USER_METRICS)[number] };
  shopRevenue: Record<string, never>;
  judgeVotes: Record<string, never>;
  competeWins: Record<string, never>;
};

export type MilestoneDetector = keyof DetectorParams;

export type MilestoneRegistryEntry = {
  [D in MilestoneDetector]: {
    detector: D;
    params: DetectorParams[D];
    launchedAt: Date;
    /** Granted and shown on the journey page, but never notified. */
    silent?: true;
  };
}[MilestoneDetector];

const SCORE_TIERS_LAUNCHED_AT = new Date('2026-10-06T00:00:00Z');
const ACTIVITY_LAUNCHED_AT = new Date('2026-10-07T00:00:00Z');
const SHOP_LAUNCHED_AT = new Date('2026-10-08T00:00:00Z');
const JUDGE_LAUNCHED_AT = new Date('2026-10-09T00:00:00Z');
const COMPETE_LAUNCHED_AT = new Date('2026-10-10T00:00:00Z');

const scoreTier = (): MilestoneRegistryEntry => ({
  detector: 'scoreSnapshot',
  params: {},
  launchedAt: SCORE_TIERS_LAUNCHED_AT,
});

const published = (entity: (typeof PUBLISHED_ENTITIES)[number]): MilestoneRegistryEntry => ({
  detector: 'publishedCount',
  params: { entity },
  launchedAt: ACTIVITY_LAUNCHED_AT,
});

// The per-model download notification already marks these moments, so the badge arrives quietly.
const downloads = (): MilestoneRegistryEntry => ({
  detector: 'modelDownloads',
  params: {},
  launchedAt: ACTIVITY_LAUNCHED_AT,
  silent: true,
});

const userMetric = (metric: (typeof USER_METRICS)[number]): MilestoneRegistryEntry => ({
  detector: 'userMetric',
  params: { metric },
  launchedAt: ACTIVITY_LAUNCHED_AT,
});

const shopRevenue = (): MilestoneRegistryEntry => ({
  detector: 'shopRevenue',
  params: {},
  launchedAt: SHOP_LAUNCHED_AT,
});

const judgeVotes = (): MilestoneRegistryEntry => ({
  detector: 'judgeVotes',
  params: {},
  launchedAt: JUDGE_LAUNCHED_AT,
});

const competeWins = (): MilestoneRegistryEntry => ({
  detector: 'competeWins',
  params: {},
  launchedAt: COMPETE_LAUNCHED_AT,
});

export const creatorMilestoneRegistry: Record<string, MilestoneRegistryEntry> = {
  ...Object.fromEntries(SCORE_TIERS.map((tier) => [scoreTierKey(tier.slug), scoreTier()])),

  'create:models-1': published('model'),
  'create:models-5': published('model'),
  'create:models-25': published('model'),
  'create:models-100': published('model'),
  'create:articles-1': published('article'),
  'create:articles-5': published('article'),
  'create:articles-25': published('article'),

  'reach:downloads-100': downloads(),
  'reach:downloads-1000': downloads(),
  'reach:downloads-10000': downloads(),
  'reach:downloads-100000': downloads(),
  'reach:followers-100': userMetric('followerCount'),
  'reach:followers-1000': userMetric('followerCount'),
  'reach:followers-10000': userMetric('followerCount'),
  'reach:reactions-1000': userMetric('reactionCount'),
  'reach:reactions-10000': userMetric('reactionCount'),
  'reach:reactions-100000': userMetric('reactionCount'),
  'reach:reactions-1000000': userMetric('reactionCount'),

  'earn:shop-sales-100000': shopRevenue(),
  'earn:shop-sales-250000': shopRevenue(),
  'earn:shop-sales-500000': shopRevenue(),
  'earn:shop-sales-1000000': shopRevenue(),
  'earn:shop-sales-2000000': shopRevenue(),

  'community:crucible-votes-500': judgeVotes(),
  'community:crucible-votes-1000': judgeVotes(),
  'community:crucible-votes-5000': judgeVotes(),
  'community:crucible-votes-10000': judgeVotes(),
  'community:crucible-votes-25000': judgeVotes(),

  'compete:wins-1': competeWins(),
  'compete:wins-5': competeWins(),
  'compete:wins-10': competeWins(),
  'compete:wins-25': competeWins(),
  'compete:wins-50': competeWins(),
  'compete:wins-100': competeWins(),
};

export type ActivityMeasure =
  | 'models'
  | 'articles'
  | 'downloads'
  | 'followers'
  | 'reactions'
  | 'revenue'
  | 'votes'
  | 'wins';

export const publishedEntityMeasures = {
  model: 'models',
  article: 'articles',
} as const satisfies Record<(typeof PUBLISHED_ENTITIES)[number], ActivityMeasure>;

export const userMetricMeasures = {
  followerCount: 'followers',
  reactionCount: 'reactions',
} as const satisfies Record<(typeof USER_METRICS)[number], ActivityMeasure>;

/** What an activity milestone counts, as the journey page groups it. Null for score tiers. */
export function activityMeasureOf(entry: MilestoneRegistryEntry): ActivityMeasure | null {
  switch (entry.detector) {
    case 'scoreSnapshot':
      return null;
    case 'publishedCount':
      return publishedEntityMeasures[entry.params.entity];
    case 'modelDownloads':
      return 'downloads';
    case 'userMetric':
      return userMetricMeasures[entry.params.metric];
    case 'shopRevenue':
      return 'revenue';
    case 'judgeVotes':
      return 'votes';
    case 'competeWins':
      return 'wins';
  }
}

export function milestoneKeysFor(detector: MilestoneDetector) {
  return Object.entries(creatorMilestoneRegistry)
    .filter(([, definition]) => definition.detector === detector)
    .map(([key]) => key);
}

/** An unregistered key is never announced: the registry is what decides a grant is news. */
export function isMilestoneAnnounced(
  milestoneKey: string,
  achievedAt: Date,
  registry: Record<string, MilestoneRegistryEntry> = creatorMilestoneRegistry
) {
  const definition = registry[milestoneKey];
  return !!definition && !definition.silent && achievedAt >= definition.launchedAt;
}
