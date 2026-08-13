// Plain strings, not a Prisma enum: adding an area costs a constant here and no
// migration, and its Flipt flag is derived from the slug.
export const FEEDBACK_AREAS = ['bitdex-image-feed'] as const;

export type FeedbackArea = (typeof FEEDBACK_AREAS)[number];

export const FEEDBACK_MESSAGE_MAX_LENGTH = 2000;

export const FEEDBACK_RATE_LIMIT = { max: 5, periodSeconds: 60 * 60 };

export const feedbackAreaFlagKey = (area: FeedbackArea) => `feedback-area-${area}`;
