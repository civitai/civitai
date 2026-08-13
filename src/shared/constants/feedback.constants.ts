// Areas are plain strings, not a Prisma enum: adding one costs a constant here
// and no migration. The Flipt flag that gates each area is derived from the
// slug (`feedback-area-<slug>`), so turning an area on or off is a flag change
// rather than a deploy.
export const FEEDBACK_AREAS = ['bitdex-image-feed'] as const;

export type FeedbackArea = (typeof FEEDBACK_AREAS)[number];

export const FEEDBACK_MESSAGE_MAX_LENGTH = 2000;

export const FEEDBACK_RATE_LIMIT = { max: 5, windowMs: 60 * 60 * 1000 };

export const feedbackAreaFlagKey = (area: FeedbackArea) => `feedback-area-${area}`;
