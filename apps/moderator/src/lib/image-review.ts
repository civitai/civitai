// Every needsReview mode served by the plain review-queue query (getImageReviewQueue). `csam` shares that
// query but is senior-gated on its own /images/csam route; `reported`/`appeal` use different query
// branches (their own pages), so they aren't ImageReviewTypes at all. Page labels come from NAVIGATION
// (access.ts) — not duplicated here.
export type ImageReviewType =
  | 'minor'
  | 'poi'
  | 'tag'
  | 'newUser'
  | 'modRule'
  | 'remixSource'
  | 'csam';

// Valid /images/[slug] modes — the staff sub-tabs. csam/reported/appeals are their own routes.
export const IMAGE_REVIEW_SLUGS = [
  'minor',
  'poi',
  'tag',
  'newUser',
  'modRule',
  'remixSource',
] as const satisfies readonly ImageReviewType[];

export type ImageReviewSlug = (typeof IMAGE_REVIEW_SLUGS)[number];

// Every /images/[slug] view: the staff review modes above + csam (senior review queue) + the report
// and appeal queues (their own services). csam/appeals are senior — gated in hooks via NAVIGATION.
export const IMAGE_VIEW_SLUGS = [
  ...IMAGE_REVIEW_SLUGS,
  'csam',
  'reported',
  'appeals',
] as const;
export type ImageViewSlug = (typeof IMAGE_VIEW_SLUGS)[number];
