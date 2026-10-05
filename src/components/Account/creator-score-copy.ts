export const CREATOR_SCORE_ANCHOR = 'creator-score';
export const CREATOR_SCORE_EXPLAINER_HREF = `/user/account#${CREATOR_SCORE_ANCHOR}`;

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

export const creatorScorePenalty = 'Content removed for breaking our rules takes points away.';
