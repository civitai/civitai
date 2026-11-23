// Literals of the data.civitai.com platform wire (its `PLATFORM` constant), shared with the feature
// frame and the platform's write path. They change only together with the platform.
export const FEATURE_PAGES_FEATURE_URN_PREFIX = 'urn:data.civitai.com:feature-pages/features/';

export const featurePageSlugRegex = /^[a-z0-9-]{1,64}$/;
export const featurePageRequestUrnRegex =
  /^urn:data\.civitai\.com:feature-pages\/requests\/[A-Za-z0-9._@-]{1,200}$/;

export const FEATURE_PAGES_MINE_MAX_REQUESTS = 100;

export const FeaturePageFrameMessage = {
  Ready: 'fp-ready',
  Init: 'fp-init',
  Vote: 'fp-vote',
  VoteResult: 'fp-vote-result',
  Mine: 'fp-mine',
  MineResult: 'fp-mine-result',
  Navigate: 'NAVIGATE',
} as const;

export type FeaturePageFrameError = 'sign_in' | 'try_again' | 'refused';
