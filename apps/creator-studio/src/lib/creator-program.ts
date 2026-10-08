// Shared Creator Program copy + constants so the /join page and the inline upsell speak with one voice.
// Enrolment in the Creator Program needs an active Civitai membership AND a creator score of
// MIN_CREATOR_SCORE+, not just a subscription tier. The CTA links out to the main-app CP page (we don't
// rebuild enrollment here).
export const CREATOR_PROGRAM_URL = 'https://civitai.com/creator-program';

// Where a user buys a Civitai membership (the subscription that, with the score bar, unlocks CP).
export const CIVITAI_MEMBERSHIP_URL = 'https://civitai.com/pricing';

// The main-app membership-management page (view plan, upgrade, cancel, update payment, benefits).
// Its server guard redirects non-members to /pricing, so only link members here.
export const CIVITAI_MANAGE_MEMBERSHIP_URL = 'https://civitai.com/user/membership';

export { CREATOR_PROGRAM_MIN_CREATOR_SCORE as MIN_CREATOR_SCORE } from '@civitai/buzz';

export const CREATOR_PROGRAM_PERKS = [
  {
    title: 'Earn real cash',
    body: 'Bank the Buzz your models earn and withdraw it as real money each month.',
  },
  {
    title: 'Charge more',
    body: 'Higher ceilings on licensing fees, access prices and permanent sales.',
  },
  {
    title: 'Earnings & analytics',
    body: 'See what your models earn and the usage that drives it.',
  },
];

// Membership raises ceilings; it never unlocks a control (CU 868kj4q49). /join/welcome lists only
// `member && !everyone` rows, so don't word an `everyone: true` row as a perk.
export const CREATOR_PROGRAM_CAPABILITIES = [
  { label: 'Browse your models & versions', everyone: true, member: true },
  { label: 'Set up timed early / paid access', everyone: true, member: true },
  { label: 'Set per-generation licensing fees', everyone: true, member: true },
  { label: 'Sell access to versions indefinitely', everyone: true, member: true },
  { label: 'Higher caps on fees, prices and permanent sales', everyone: false, member: true },
  { label: 'Bank Buzz to claim a share of the Compensation Pool', everyone: false, member: true },
];

// The scoring multipliers are tunable server-side, so these name categories and activities only: no
// numbers and no "counts more" ordering. Moderation/report components are excluded (not creator actions).
// 🔴 The activity wording must match `creatorScoreActivities` in the main app's
// src/components/Account/creator-score-copy.ts, which this app cannot import; a test pins the two.
export const CREATOR_SCORE_TIPS = [
  {
    title: 'Build your following',
    body: 'Your follower count raises your score. Post regularly and engage with the community to grow it.',
  },
  {
    title: 'Publish models people use',
    body: 'Downloads, generations, and positive reviews of your models all raise your score.',
  },
  {
    title: 'Share images & posts',
    body: 'Reactions and comments on the images you post count toward your score.',
  },
  {
    title: 'Write articles',
    body: 'Views, reactions, and comments on your articles add to your score too.',
  },
];
