import { z } from 'zod';
import {
  StorylineFollowScope,
  StorylineStatus,
  StorylineWhoCanContinue,
} from '~/shared/utils/prisma/enums';
import { PG_INT4_MAX } from '~/server/common/constants';
import { imageInputSchema } from '~/server/schema/image.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import {
  STORYLINE_CAPTION_MAX_LENGTH,
  STORYLINE_CEILING_LEVELS,
  STORYLINE_PATH_LIMIT,
} from '~/shared/utils/storyline';
import { COMMENT_ALLOWED_TAGS } from '~/utils/html-sanitize-helpers';

const ceilingSchema = z
  .number()
  .int()
  .refine((value) => (STORYLINE_CEILING_LEVELS as readonly number[]).includes(value), {
    message: 'Invalid maximum rating',
  });

const titleSchema = z.string().trim().min(1).max(255);

/** The owner's cover and banner picks; null clears one. Which images are allowed is the server's. */
const picksSchema = {
  coverImageId: z.number().int().positive().nullable().optional(),
  heroImageId: z.number().int().positive().nullable().optional(),
  /** The banner's vertical focus, 0 (top) to 100 (bottom). */
  heroImagePosition: z.number().int().min(0).max(100).optional(),
};

export const createStorylineSchema = z.object({
  /** Chapter 1, when the storyline starts from a post already published. Omitted, it starts empty. */
  postId: z.number().int().positive().optional(),
  /** Someone's image the storyline starts from, credited above chapter 1. Not a chapter. */
  sparkImageId: z.number().int().positive().optional(),
  title: titleSchema,
  maxNsfwLevel: ceilingSchema,
  whoCanContinue: z.nativeEnum(StorylineWhoCanContinue).optional(),
  ...picksSchema,
});
export type CreateStorylineInput = z.infer<typeof createStorylineSchema>;

// Must not accept an image id: an upload is always a new image.
const storylineUploadSchema = imageInputSchema.extend({
  type: z.literal('image').default('image'),
});

export const updateStorylineSchema = z.object({
  id: z.number().int().positive(),
  title: titleSchema.optional(),
  status: z.nativeEnum(StorylineStatus).optional(),
  maxNsfwLevel: ceilingSchema.optional(),
  whoCanContinue: z.nativeEnum(StorylineWhoCanContinue).optional(),
  ...picksSchema,
  /** A still image the caller just uploaded, to make theirs and pick as the cover or banner. */
  coverUpload: storylineUploadSchema.optional(),
  heroUpload: storylineUploadSchema.optional(),
});
export type UpdateStorylineInput = z.infer<typeof updateStorylineSchema>;

/** Empty text deletes the caption. */
export const setStorylineImageCaptionSchema = z.object({
  imageId: z.number().int().positive(),
  content: z.string().trim().max(STORYLINE_CAPTION_MAX_LENGTH),
});

export const addStorylineTextSchema = z.object({
  postId: z.number().int().positive(),
  /** Shares `Image.index`'s number space on the post: the item it follows, or the first index − 1. */
  index: z.number().int().min(-PG_INT4_MAX).max(PG_INT4_MAX),
});

export const setStorylineTextSchema = z.object({
  id: z.number().int().positive(),
  // Text only: the scan rates words, so media in a text item would go unrated.
  content: getSanitizedStringSchema({ allowedTags: COMMENT_ALLOWED_TAGS }),
});

export const storylineTextIdSchema = z.object({ id: z.number().int().positive() });

export const storylinePostImageCaptionsSchema = z.object({ postId: z.number().int().positive() });

export const storylineCollaboratorSchema = z.object({
  storylineId: z.number().int().positive(),
  userId: z.number().int().positive(),
});

/** A collaborator stepping down from a storyline: always themselves, so no user id is taken. */
export const leaveStorylineSchema = z.object({ storylineId: z.number().int().positive() });

export const addOwnerChapterSchema = z.object({
  parentChapterId: z.number().int().positive(),
  postId: z.number().int().positive(),
});

export const setFirstChapterSchema = z.object({
  storylineId: z.number().int().positive(),
  postId: z.number().int().positive(),
});

export const storylineChapterSchema = z.object({ chapterId: z.number().int().positive() });

/** `browsingLevel` is optional so the request's own level and the domain cap can fill it in. */
export const storylineChapterReadSchema = storylineChapterSchema.extend({
  browsingLevel: z.number().int().min(0).optional(),
});
export type StorylineChapterReadInput = z.infer<typeof storylineChapterReadSchema>;

/** `via`: the chapters the reader came through into each rejoined chapter on their route. */
export const storylinePathSchema = storylineChapterReadSchema.extend({
  via: z.array(z.number().int().positive().max(PG_INT4_MAX)).max(STORYLINE_PATH_LIMIT).optional(),
});

/** `parentChapterId` names the route when the chapter continues several chapters. */
export const setCanonChapterSchema = storylineChapterSchema.extend({
  parentChapterId: z.number().int().positive().optional(),
});

export const insertStorylineChapterSchema = z.object({
  storylineId: z.number().int().positive(),
  parentChapterId: z.number().int().positive(),
  childChapterId: z.number().int().positive(),
  postId: z.number().int().positive(),
});

export const moveStorylineChapterSchema = z.object({
  storylineId: z.number().int().positive(),
  chapterId: z.number().int().positive(),
  afterChapterId: z.number().int().positive(),
});

export const removeStorylineChapterSchema = z.object({
  chapterId: z.number().int().positive(),
});

export const linkStorylineChapterSchema = z.object({
  parentChapterId: z.number().int().positive(),
  chapterId: z.number().int().positive(),
  atEnd: z.boolean().optional(),
});

export const storylineLinkTargetsSchema = z.object({
  parentChapterId: z.number().int().positive(),
});

export const storylineIdSchema = z.object({ id: z.number().int().positive() });

export const storylinePendingForPostSchema = z.object({ postId: z.number().int().positive() });

export const getStorylineSchema = z.object({
  id: z.number().int().positive(),
  browsingLevel: z.number().int().min(0).optional(),
});

export const STORYLINE_FOR_POSTS_MAX = 100;

export const getStorylinesForPostsSchema = z.object({
  postIds: z.array(z.number().int().positive()).max(STORYLINE_FOR_POSTS_MAX),
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

export const followStorylineSchema = z.object({
  storylineId: z.number().int().positive(),
  scope: z.nativeEnum(StorylineFollowScope).default(StorylineFollowScope.Canon),
  browsingLevel: z.number().int().min(0).optional(),
});

export const getStorylinesInfiniteSchema = z.object({
  filter: z
    .enum(['all', 'ongoing', 'complete', 'open', 'mine', 'participated', 'following'])
    .default('all'),
  sort: z.enum(['newest', 'mostChapters', 'recentlyUpdated']).default('newest'),
  cursor: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  browsingLevel: z.number().int().min(0).optional(),
  /** One owner's storylines, as their profile lists them. */
  userId: z.number().int().positive().optional(),
});

export const moderateStorylineTitleSchema = z
  .object({
    id: z.number().int().positive(),
    /** null hands the title's rating back to the scan. */
    moderatorNsfwLevel: ceilingSchema.nullable().optional(),
    /** The title the moderator read; refused if it has changed since. */
    liftScanTakedown: z.object({ reviewedTitle: z.string() }).optional(),
  })
  .refine((input) => input.moderatorNsfwLevel !== undefined || !!input.liftScanTakedown, {
    message: 'Nothing to change',
  });
export type ModerateStorylineTitleInput = z.infer<typeof moderateStorylineTitleSchema>;

export const setStorylineTakedownSchema = z.object({
  id: z.number().int().positive(),
  takenDown: z.boolean(),
});
