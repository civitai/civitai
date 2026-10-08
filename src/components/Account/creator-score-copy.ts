import { capitalize } from '~/utils/string-helpers';

export const CREATOR_SCORE_ANCHOR = 'creator-score';

/**
 * What earns score on each kind of work. Main-app surfaces build from here; Creator Studio cannot
 * import it and keeps its own copy in `CREATOR_SCORE_TIPS`, so change both together.
 */
export const creatorScoreActivities = {
  models: 'downloads, generations, and positive reviews',
  images: 'reactions and comments',
  articles: 'views, reactions, and comments',
} as const;

// Categories and activities only: no weights, no numbers, and no "counts more" ordering.
// Weights are tunable config and may change; anything stated here would go stale with them.
export const creatorScoreSources = {
  models: { label: 'Models', earnedBy: `${capitalize(creatorScoreActivities.models)} of models` },
  images: { label: 'Images', earnedBy: `${capitalize(creatorScoreActivities.images)} on images` },
  articles: {
    label: 'Articles',
    earnedBy: `${capitalize(creatorScoreActivities.articles)} on articles`,
  },
  users: { label: 'Followers', earnedBy: 'Follower count' },
  reportsActioned: {
    label: 'Helping moderation',
    earnedBy: 'Reports filed that moderators act on',
  },
} as const;

export const creatorScoreGrowsWhen = 'people use, react to, and follow your work';

export const creatorScorePenalty = 'Images removed for breaking our rules take points away.';
