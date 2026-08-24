/**
 * The image/video feed tag bar's chip set, in display order.
 *
 * 🔴 CURATED BY HAND. Do not derive this list from search volume, and do not extend it
 * by sorting a log and taking the top N — ranking by demand is what puts terms on a
 * public category bar that must never appear there. Every addition has to be reviewed
 * as a general-subject term, and `Tag.nsfwLevel` cannot make that judgement for you.
 * The curation rationale, the demand analysis and the excluded classes live on the
 * ClickUp ticket, not here.
 *
 * Entries also have to clear supply, not just demand: a term with real interest and
 * almost nothing tagged lands users on an empty feed.
 *
 * A deliberately low-demand chip is kept in the set. That is not an oversight — the
 * click-through instrumentation on this bar exists to settle whether such a chip earns
 * its place once it is in front of people, rather than guessing.
 *
 * These are `Tag.name` values, resolved to ids at request time by `getFeedTagBarTags`.
 * Several are not `image category` tags and several are `UserGenerated` rather than
 * `Label`, which is why the bar does not reuse the category list.
 */
export const FEED_TAG_BAR_TAG_NAMES = [
  'animal',
  'anime',
  'beach',
  'cartoon',
  'cat',
  'comics',
  'cosplay',
  'cyberpunk',
  'dog',
  'dragon',
  'elf',
  'fantasy',
  'furry',
  'maid',
  'manga',
  'mecha',
  'monster',
  'portrait',
  'realistic',
  'robot',
  'selfie',
  'steampunk',
] as const;

export type FeedTagBarTagName = (typeof FEED_TAG_BAR_TAG_NAMES)[number];
