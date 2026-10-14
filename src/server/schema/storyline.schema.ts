import { z } from 'zod';
import { StorylineStatus, StorylineWhoCanContinue } from '~/shared/utils/prisma/enums';
import { STORYLINE_CEILING_LEVELS } from '~/shared/utils/storyline';

const ceilingSchema = z
  .number()
  .int()
  .refine((value) => (STORYLINE_CEILING_LEVELS as readonly number[]).includes(value), {
    message: 'Invalid maximum rating',
  });

const titleSchema = z.string().trim().min(1).max(255);

export const createStorylineSchema = z.object({
  postId: z.number().int().positive(),
  title: titleSchema,
  maxNsfwLevel: ceilingSchema,
  whoCanContinue: z.nativeEnum(StorylineWhoCanContinue).optional(),
});
export type CreateStorylineInput = z.infer<typeof createStorylineSchema>;

export const updateStorylineSchema = z.object({
  id: z.number().int().positive(),
  title: titleSchema.optional(),
  status: z.nativeEnum(StorylineStatus).optional(),
  maxNsfwLevel: ceilingSchema.optional(),
  whoCanContinue: z.nativeEnum(StorylineWhoCanContinue).optional(),
});
export type UpdateStorylineInput = z.infer<typeof updateStorylineSchema>;

export const storylineCollaboratorSchema = z.object({
  storylineId: z.number().int().positive(),
  userId: z.number().int().positive(),
});

export const addOwnerChapterSchema = z.object({
  parentChapterId: z.number().int().positive(),
  postId: z.number().int().positive(),
});

export const storylineChapterSchema = z.object({ chapterId: z.number().int().positive() });

/** `browsingLevel` is optional so the request's own level and the domain cap can fill it in. */
export const storylineChapterReadSchema = storylineChapterSchema.extend({
  browsingLevel: z.number().int().min(0).optional(),
});
export type StorylineChapterReadInput = z.infer<typeof storylineChapterReadSchema>;

export const storylineIdSchema = z.object({ id: z.number().int().positive() });

export const getStorylineSchema = z.object({
  id: z.number().int().positive(),
  browsingLevel: z.number().int().min(0).optional(),
});

export const getStorylinesForPostsSchema = z.object({
  postIds: z.array(z.number().int().positive()).max(100),
  browsingLevel: z.number().int().min(0).optional(),
});

export const storylineBranchChoiceSchema = z.object({
  fromChapterId: z.number().int().positive(),
  toChapterId: z.number().int().positive(),
  browsingLevel: z.number().int().min(0).optional(),
});

export const joinStorylineEarlyAccessSchema = z
  .object({ storylineId: z.number().int().positive().optional() })
  .default({});

export const getStorylinesInfiniteSchema = z.object({
  filter: z.enum(['all', 'ongoing', 'complete', 'open']).default('all'),
  sort: z.enum(['newest', 'mostChapters']).default('newest'),
  cursor: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  browsingLevel: z.number().int().min(0).optional(),
});
