import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import type { RateLimit } from '~/server/middleware.trpc';
import { constants } from '~/server/common/constants';
import { ThreadSort } from '~/server/common/enums';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { surfaceMayContainStickers } from '~/shared/utils/sticker-token';
import { COMMENT_ALLOWED_TAGS } from '~/utils/html-sanitize-helpers';

export type CommentConnectorInput = z.infer<typeof commentConnectorSchema>;
export const commentConnectorSchema = z.object({
  entityId: z.number(),
  entityType: z.enum([
    'question',
    'answer',
    'image',
    'post',
    'model',
    'comment',
    'review',
    'article',
    'bounty',
    'bountyEntry',
    'challenge',
    'comicChapter',
    'model3d',
    'model3dReview',
    'appListing',
  ]),
  hidden: z.boolean().nullish(),
  parentThreadId: z.number().optional(),
  excludedUserIds: z.array(z.number()).optional(),
});

export type UpsertCommentV2Input = z.infer<typeof upsertCommentv2Schema>;
export const upsertCommentv2Schema = commentConnectorSchema.extend({
  id: z.number().optional(),
  content: getSanitizedStringSchema({
    allowedTags: COMMENT_ALLOWED_TAGS,
    // Read from STICKER_SURFACES rather than hardcoded, so "may contain a
    // sticker" and "charges for one" can't drift apart — that split is what let
    // sticker markup be containable on surfaces that never charged.
    allowStickers: surfaceMayContainStickers('comment'),
  })
    .refine((data) => {
      return data && data.length > 0 && data !== '<p></p>';
    }, 'Cannot be empty')
    .refine((data) => data.length <= constants.comments.maxLength, 'Comment content too long'),
  nsfw: z.boolean().optional(),
  tosViolation: z.boolean().optional(),
});

export type ToggleHideCommentInput = z.infer<typeof toggleHideCommentSchema>;
export const toggleHideCommentSchema = z.object({
  id: z.number(),
  entityId: z.number(),
  entityType: z.enum([
    'question',
    'answer',
    'image',
    'post',
    'model',
    'comment',
    'review',
    'article',
    'bounty',
    'bountyEntry',
    'challenge',
    'comicChapter',
    'model3d',
    'model3dReview',
    'appListing',
  ]),
});

export type GetCommentsInfiniteInput = z.infer<typeof getCommentsInfiniteSchema>;
export const getCommentsInfiniteSchema = commentConnectorSchema.extend({
  limit: z.number().min(1).max(100).default(20),
  sort: z.enum(ThreadSort).default(ThreadSort.Oldest),
  cursor: z.number().optional(),
  // If set on the first page, the server will include this comment in the response when
  // it belongs to the thread but isn't in the initial batch (e.g. notification deep-links).
  targetCommentId: z.number().optional(),
  // How many reply levels below this page to return alongside it. Lets a surface render
  // every thread open without one round-trip per comment per level.
  repliesDepth: z.number().min(0).max(20).optional(),
  repliesLimit: z.number().min(1).max(50).default(constants.comments.replyPageSize),
});

export const toggleThreadMuteSchema = z.object({
  commentId: z.number(),
});
export type ToggleThreadMuteInput = z.infer<typeof toggleThreadMuteSchema>;

/**
 * Muting is a normal, repeatable user action, so this is generous by design — it exists to bound
 * enumeration, not to ration the feature. Both mute endpoints share one budget (see the router), or
 * the budget is simply twice as large as it reads.
 */
export const muteRateLimits: RateLimit[] = [
  { limit: 60, period: CacheTTL.hour },
  { limit: 300, period: CacheTTL.day },
];

/**
 * The entity types a section mute can address: every one whose `Thread` row is findable by a single
 * unique column, `<entityType>Id`.
 *
 * `comicChapter` is excluded because there is no `comicChapterId` — comic threads hang off
 * `@@unique([comicProjectId, comicChapterPosition])`. Passing it builds `where: { comicChapterId }`,
 * which Prisma rejects as an unknown argument, so the endpoint 500s rather than returning "not
 * muted". The comics page does supply that entityType, so this is reachable rather than theoretical.
 *
 * `comment` is excluded for a different reason: a comment's thread is muted through
 * `toggleThreadMute`, which takes the comment id. Routing it here as well would give one thread two
 * doors with different names.
 */
export const sectionMuteSchema = commentConnectorSchema.pick({ entityId: true }).extend({
  entityType: commentConnectorSchema.shape.entityType.exclude(['comicChapter', 'comment']),
});
export type SectionMuteInput = z.infer<typeof sectionMuteSchema>;
