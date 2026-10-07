/**
 * Every creator milestone the code can grant, keyed by its CreatorMilestone key. Names, thresholds,
 * hints and cosmetics live on the row; this says which detector grants the key, with what params,
 * and from when a grant is announced. A definition achieved before its launchedAt is granted
 * silently, so shipping a new one backfills existing qualifiers without a notification flood.
 *
 * Keys are permanent: renaming one re-grants everyone under the new key.
 */

export const PUBLISHED_ENTITIES = ['model', 'article'] as const;
export const USER_METRICS = ['followerCount', 'reactionCount'] as const;

type DetectorParams = {
  // Thresholds stay on the CreatorMilestone rows, so the score detector takes none.
  scoreSnapshot: Record<string, never>;
  publishedCount: { entity: (typeof PUBLISHED_ENTITIES)[number] };
  modelDownloads: Record<string, never>;
  userMetric: { metric: (typeof USER_METRICS)[number] };
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

const scoreTier = (): MilestoneRegistryEntry => ({
  detector: 'scoreSnapshot',
  params: {},
  launchedAt: SCORE_TIERS_LAUNCHED_AT,
});

// Silent until the journey page has an Achievements section to show them in: a notification would
// link to a page that does not show the milestone. Turning this off changes each group's watermark
// fingerprint, so its first announced run is silent and nobody's backlog is announced.
const ACTIVITY_SILENT_UNTIL_ACHIEVEMENTS_SECTION = true as const;

const published = (entity: (typeof PUBLISHED_ENTITIES)[number]): MilestoneRegistryEntry => ({
  detector: 'publishedCount',
  params: { entity },
  launchedAt: ACTIVITY_LAUNCHED_AT,
  silent: ACTIVITY_SILENT_UNTIL_ACHIEVEMENTS_SECTION,
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
  silent: ACTIVITY_SILENT_UNTIL_ACHIEVEMENTS_SECTION,
});

export const creatorMilestoneRegistry: Record<string, MilestoneRegistryEntry> = {
  'score:spark': scoreTier(),
  'score:kindle': scoreTier(),
  'score:flame': scoreTier(),
  'score:blaze': scoreTier(),
  'score:beacon': scoreTier(),
  'score:nova': scoreTier(),
  'score:star': scoreTier(),
  'score:supernova': scoreTier(),
  'score:legend': scoreTier(),

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
};

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
