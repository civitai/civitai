// Shared Creator Program copy + constants so the /join page and the inline upsell speak with one voice.
// The gate (B1) is full Creator Program membership — an active Civitai membership AND a creator score of
// MIN_CREATOR_SCORE+ — not just a subscription tier. The CTA links out to the main-app CP page (we don't
// rebuild enrollment here).
export const CREATOR_PROGRAM_URL = 'https://civitai.com/creator-program';

// Where a user buys/manages a Civitai membership (the subscription that, with the score bar, unlocks CP).
export const CIVITAI_MEMBERSHIP_URL = 'https://civitai.com/pricing';

// Mirrors the main app's MIN_CREATOR_SCORE (src/shared/constants/creator-program.constants.ts). Keep in sync.
export const MIN_CREATOR_SCORE = 40000;

export const CREATOR_PROGRAM_PERKS = [
  {
    title: 'Earn real cash',
    body: 'Bank the Buzz your models earn and withdraw it as real money each month.',
  },
  {
    title: 'Set licensing fees',
    body: 'Charge a per-image fee when others generate with your models.',
  },
  { title: 'Sell access indefinitely', body: 'Offer your versions for sale with no time limit.' },
  {
    title: 'Earnings & analytics',
    body: 'See what your models earn and the usage that drives it.',
  },
];

// What the Studio actually gates on Creator Program membership vs. what any owner can do. Early/paid access
// (timed) is intentionally NOT member-gated — only the fee + indefinite-sale write actions are.
export const CREATOR_PROGRAM_CAPABILITIES = [
  { label: 'Browse your models & versions', everyone: true, member: true },
  { label: 'Set up timed early / paid access', everyone: true, member: true },
  { label: 'Set per-image licensing fees', everyone: false, member: true },
  { label: 'Sell access to versions indefinitely', everyone: false, member: true },
];

// Actionable ways to raise the creator score, ordered by impact. Mirrors the main app's scoring job
// (update-user-score.ts): followers dominate, then model usage (downloads/generations/reviews), then image &
// article engagement (reactions/comments). Kept qualitative — the exact multipliers live server-side and
// change, so we don't quote numbers. Moderation/report components are excluded (not creator actions).
export const CREATOR_SCORE_TIPS = [
  {
    title: 'Build your following',
    body: 'Followers are the largest factor in your score — post regularly and engage with the community to grow it.',
  },
  {
    title: 'Publish models people use',
    body: 'Downloads, on-site generations, and reviews on your models all raise your score.',
  },
  {
    title: 'Share images & posts',
    body: 'Reactions and comments on the images you post count toward your score.',
  },
  {
    title: 'Write articles',
    body: 'Reactions and comments on your articles add to your score too.',
  },
];
