import { ReviewReactions } from '@prisma/client';
import { z } from 'zod';

export const reactableEntities: readonly [string, ...string[]] = [
  'question',
  'answer',
  'comment',
  'commentOld',
  'image',
  'post',
  'resourceReview',
  'article',
  'bountyEntry',
  'clubPost',
];

export type ReactionEntityType = ToggleReactionInput['entityType'];
export type ToggleReactionInput = z.infer<typeof toggleReactionSchema>;
export const toggleReactionSchema = z.object({
  entityId: z.number(),
  entityType: z.enum(reactableEntities),
  reaction: z.nativeEnum(ReviewReactions),
});
