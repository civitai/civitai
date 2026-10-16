/**
 * The reasons a moderator may unpublish an ARTICLE, mirrored from the main app's
 * `articleUnpublishReasons` (`src/server/common/moderation-helpers.ts`). The key is stored in the
 * article's `metadata.unpublishedReason`, and the site renders the author's banner from it, so a key
 * the main app does not know shows the author no reason at all. The main app's
 * `moderator-unpublish-reason-parity.test.ts` holds the two together.
 *
 * Labels only — the author-facing wording stays in the main app, which is the only side that shows it.
 */
export const ARTICLE_UNPUBLISH_REASONS = [
  { value: 'mature-real-person', label: 'Depiction of real-person likeness' },
  { value: 'mature-underage', label: 'Minors displayed in a mature context' },
  { value: 'photo-real-underage', label: 'Photorealistic depiction of a minor' },
  { value: 'hate-speech', label: 'Promotion of hate-speech or targeted attack' },
  { value: 'scat', label: 'Depiction of scat, fecal matter, urine, or diapers' },
  { value: 'violence', label: 'Prohibited violent activities' },
  { value: 'self-harm', label: 'Self-harm, body image disorders, or dangerous behavior' },
  { value: 'beastiality', label: 'Depiction of "bestiality"' },
  { value: 'spam', label: 'Spam or advertorial content' },
  { value: 'unintenteded-use', label: 'Unintended site use' },
  { value: 'insufficient-description', label: 'Insufficient content' },
  { value: 'duplicate', label: 'Duplicate article' },
  { value: 'other', label: 'Other' },
] as const;

export type ArticleUnpublishReason = (typeof ARTICLE_UNPUBLISH_REASONS)[number]['value'];

export const isArticleUnpublishReason = (v: unknown): v is ArticleUnpublishReason =>
  ARTICLE_UNPUBLISH_REASONS.some((r) => r.value === v);

/** A stored reason key in the site's own words; an unknown key (an older reason) as it was stored. */
export const articleUnpublishReasonLabel = (key: string) =>
  ARTICLE_UNPUBLISH_REASONS.find((r) => r.value === key)?.label ?? key;
