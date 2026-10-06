export const CREATOR_SCORE_ANCHOR = 'creator-score';

// Categories and activities only: no weights, no numbers, and no "counts more" ordering.
// Weights are tunable config and may change; anything stated here would go stale with them.
export const creatorScoreSources = {
  models: {
    label: 'Models',
    earnedBy: 'Downloads, generations, and positive reviews of models',
  },
  images: { label: 'Images', earnedBy: 'Reactions and comments on images' },
  articles: { label: 'Articles', earnedBy: 'Views, reactions, and comments on articles' },
  users: { label: 'Followers', earnedBy: 'Follower count' },
  reportsActioned: {
    label: 'Helping moderation',
    earnedBy: 'Reports filed that moderators act on',
  },
} as const;

export const creatorScoreGrowsWhen = 'people use, react to, and follow your work';

export const creatorScorePenalty = 'Images removed for breaking our rules take points away.';
