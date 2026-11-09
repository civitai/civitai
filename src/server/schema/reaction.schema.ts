import { ReviewReactions } from '~/shared/utils/prisma/enums';
import * as z from 'zod';

import { usageLimits } from '~/shared/constants/usage-limits';

export { REACTION_RATE_LIMIT_MIN_CREATOR_SCORE } from '~/shared/constants/usage-limits';

export const reactionRateLimits = usageLimits(
  'reactions.minute',
  'reactions.ten-minutes',
  'reactions.hourly',
  'reactions.daily'
);

// `as const` (not `readonly [string, ...string[]]`) so `ReactionEntityType` stays a
// literal union — the block-check owner resolver switches exhaustively over it.
export const reactableEntities = [
  'comment',
  'image',
  'post',
  'resourceReview',
  'article',
  'bountyEntry',
] as const;

/**
 * Cap matches `getStickerPlacementsSchema`, the other per-viewer batch a feed surface makes, so
 * both chunk at the same size. The client chunks rather than truncating: a partially hydrated
 * grid leaves the un-hydrated cards showing an un-given reaction, which is the state that gets a
 * viewer to click their own reaction off again.
 */
export type GetMyImageReactionsInput = z.infer<typeof getMyImageReactionsSchema>;
export const getMyImageReactionsSchema = z.object({
  imageIds: z.array(z.number()).min(1).max(100),
});

export type ReactionEntityType = ToggleReactionInput['entityType'];
export type ToggleReactionInput = z.infer<typeof toggleReactionSchema>;
/**
 * `reaction` accepts every enum value because toggling is also how a legacy reaction (a Dislike
 * on an image) is removed. What may be created is `allowedReactionsByEntity`, enforced in
 * `toggleReactionHandler`, which knows whether the call creates.
 */
export const toggleReactionSchema = z.object({
  entityId: z.number(),
  entityType: z.enum(reactableEntities),
  reaction: z.enum(ReviewReactions),
});

/** `waitForPoints: false` (a viewer with event cosmetics off): answer without waiting for points. */
export type ToggleReactionWithPointsInput = z.infer<typeof toggleReactionWithPointsSchema>;
export const toggleReactionWithPointsSchema = toggleReactionSchema.extend({
  waitForPoints: z.boolean().optional(),
});

const contentReactions = ['Like', 'Heart', 'Laugh', 'Cry'] as const satisfies ReviewReactions[];

/**
 * The reactions a user may create on each entity type: the set the site's own UI offers.
 * The display filter in `src/components/Reaction/Reactions.tsx` is a separate copy.
 * - `resourceReview` has no reaction UI; it gets the standard set so the API can still use it.
 */
export const allowedReactionsByEntity: Record<
  (typeof reactableEntities)[number],
  readonly ReviewReactions[]
> = {
  image: contentReactions,
  post: contentReactions,
  article: contentReactions,
  bountyEntry: contentReactions,
  comment: contentReactions,
  resourceReview: contentReactions,
};

export const isReactionAllowedForEntity = (
  entityType: ReactionEntityType,
  reaction: ReviewReactions
) => allowedReactionsByEntity[entityType].includes(reaction);
