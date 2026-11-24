// Literals of the data.civitai.com platform wire (its `PLATFORM` constant), shared with the feature
// frame and the platform's write path. They change only together with the platform.
export const FEATURE_PAGES_FEATURE_URN_PREFIX = 'urn:data.civitai.com:feature-pages/features/';

export const featurePageSlugRegex = /^[a-z0-9-]{1,64}$/;
/** The longest comment text the platform takes. */
export const FEATURE_PAGES_TEXT_MAX_LENGTH = 4000;
export const featurePageRequestUrnRegex =
  /^urn:data\.civitai\.com:feature-pages\/requests\/[A-Za-z0-9._@-]{1,200}$/;
/** A thread's subject: a feature by its slug, or a feature request. */
export const featurePageSubjectUrnRegex =
  /^urn:data\.civitai\.com:feature-pages\/(features\/[a-z0-9-]{1,64}|requests\/[A-Za-z0-9._@-]{1,200})$/;
/** A comment the platform holds. Shape-checked only; the mirror maps it to a civitai comment. */
export const featurePageCommentUrnRegex = /^urn:data\.civitai\.com:[A-Za-z0-9._@/:-]{1,300}$/;

export const FEATURE_PAGES_MINE_MAX_REQUESTS = 100;

export const FeaturePageFrameMessage = {
  Ready: 'fp-ready',
  Init: 'fp-init',
  Vote: 'fp-vote',
  VoteResult: 'fp-vote-result',
  Mine: 'fp-mine',
  MineResult: 'fp-mine-result',
  Comment: 'fp-comment',
  CommentEdit: 'fp-comment-edit',
  CommentRetract: 'fp-comment-retract',
  CommentReport: 'fp-comment-report',
  CommentResult: 'fp-comment-result',
  Navigate: 'NAVIGATE',
} as const;

export type FeaturePageFrameError = 'sign_in' | 'try_again' | 'refused' | 'blocked';
