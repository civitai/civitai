export type ImageReviewType =
  | 'minor'
  | 'poi'
  | 'tag'
  | 'newUser'
  | 'modRule'
  | 'remixSource'
  | 'csam';

export const IMAGE_REVIEW_SLUGS = [
  'minor',
  'poi',
  'tag',
  'newUser',
  'modRule',
  'remixSource',
] as const satisfies readonly ImageReviewType[];

export type ImageReviewSlug = (typeof IMAGE_REVIEW_SLUGS)[number];

export const IMAGE_VIEW_SLUGS = [
  ...IMAGE_REVIEW_SLUGS,
  'csam',
  'reported',
  'appeals',
] as const;
export type ImageViewSlug = (typeof IMAGE_VIEW_SLUGS)[number];
