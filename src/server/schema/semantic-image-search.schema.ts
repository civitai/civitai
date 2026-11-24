import * as z from 'zod';
import { baseQuerySchema } from '~/server/schema/base.schema';
import { baseModels } from '~/shared/constants/basemodel.constants';
import { MediaType } from '~/shared/utils/prisma/enums';
import { videoLengthPresets } from '~/shared/constants/video-length.constants';

export const SEMANTIC_QUERY_MAX_LENGTH = 500;
export const SEMANTIC_SEARCH_PAGE_SIZE = 50;
export const MAX_SEARCH_MODEL_VERSIONS = 20;

/**
 * The query as typed: the service's spelling correction is skipped ("Search instead for"). The text
 * is still audited as any query is.
 */
export const semanticSpellcheckField = z.literal(false).optional();

export type SemanticImageSearchInput = z.infer<typeof semanticImageSearchSchema>;
export const semanticImageSearchSchema = baseQuerySchema
  .extend({
    query: z.string().trim().max(SEMANTIC_QUERY_MAX_LENGTH).optional(),
    spellcheck: semanticSpellcheckField,
    // "More like this": the image whose vector is the query.
    imageId: z.number().int().positive().optional(),
    // "More like this" without the viewer's own images (results only, never the source image).
    excludeOwn: z.boolean().optional(),
    // Room for whatever the images feed can select: its filters carry into the search unchanged.
    tagIds: z.number().int().array().max(100).optional(),
    // By name, as the image search URLs and pickers carry them; resolved to ids on the server.
    tagNames: z.string().trim().min(1).array().max(20).optional(),
    excludedTagIds: z.number().int().array().max(50).optional(),
    baseModels: z.string().array().max(baseModels.length).optional(),
    // Images made with any of these model versions (behind `imageSearchResources`).
    modelVersionIds: z.number().int().positive().array().max(MAX_SEARCH_MODEL_VERSIONS).optional(),
    types: z.enum(MediaType).array().optional(),
    usernames: z.string().trim().min(1).array().max(20).optional(),
    // The images feed's `?userId=`, as it filters by id.
    userIds: z.number().int().positive().array().max(20).optional(),
    // Bounds on `sortAt`, the publish time for a published image.
    postedAfter: z.coerce.date().optional(),
    postedBefore: z.coerce.date().optional(),
    // Video searches only; ignored for images.
    length: z.enum(videoLengthPresets).optional(),
    // The feed's "Made On-site": generated here, as the feed judges it from the image's meta.
    fromPlatform: z.boolean().optional(),
    withMeta: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(SEMANTIC_SEARCH_PAGE_SIZE),
    // Offset into the ranked candidate list.
    cursor: z.number().int().min(0).optional(),
    // newest: the best matches by similarity, newest first (text queries only; "more like this"
    // stays in similarity order). Absent or relevance: similarity order.
    sort: z.enum(['relevance', 'newest']).optional(),
  })
  .refine((x) => !!x.query || !!x.imageId, { message: 'Enter a query' });

/** A moderator case's public reference (apps/moderator `PUBLIC_REF_PATTERN`). */
const CASE_REF_PATTERN = /^TD-\d{2}-[0-9A-HJKMNP-TV-Z]{6}$/;
/** The site item a search upload starts from: required, and recorded with the upload. */
export const searchUploadSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.enum(['image', 'post', 'modelVersion']),
    id: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('case'), id: z.string().regex(CASE_REF_PATTERN) }),
]);
export type SearchUploadSource = z.infer<typeof searchUploadSourceSchema>;
export const prepareImageSearchUploadSchema = z.object({
  uploadUrl: z.string().max(2048),
  source: searchUploadSourceSchema,
});
export const imageSearchUploadStatusSchema = z.object({ uploadId: z.string().uuid() });
export const imageSearchUploadSearchSchema = baseQuerySchema.extend({
  uploadId: z.string().uuid(),
  uploadUrl: z.string().max(2048),
  limit: z.number().int().min(1).max(100).default(SEMANTIC_SEARCH_PAGE_SIZE),
  cursor: z.number().int().min(0).optional(),
});

export type SemanticSearchFeedbackInput = z.infer<typeof semanticSearchFeedbackSchema>;
export const semanticSearchFeedbackSchema = z.object({
  rating: z.enum(['up', 'down']),
  comment: z.string().trim().max(2000).optional(),
  query: z.string().trim().max(SEMANTIC_QUERY_MAX_LENGTH).optional(),
  imageId: z.number().int().positive().optional(),
  filters: z.string().max(1000).optional(),
  resultCount: z.number().int().min(0).optional(),
  latencyMs: z.number().int().min(0).optional(),
});
