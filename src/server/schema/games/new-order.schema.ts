import * as z from 'zod';
import { newOrderConfig } from '~/server/common/constants';
import { NewOrderDamnedReason, NewOrderImageRatingStatus, NsfwLevel } from '~/server/common/enums';
import { infiniteQuerySchema } from '~/server/schema/base.schema';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

export type GetImagesQueueSchema = z.input<typeof getImagesQueueSchema>;
export const getImagesQueueSchema = z.object({
  imageCount: z.number().optional().default(20),
  queueType: z.enum(NewOrderRankType).optional(), // For moderator testing only
});

export type GetPlayersInfiniteSchema = z.infer<typeof getPlayersInfiniteSchema>;
export const getPlayersInfiniteSchema = infiniteQuerySchema.extend({
  query: z.string().trim().min(1).optional(),
});

export type SmitePlayerInput = z.infer<typeof smitePlayerSchema>;
export const smitePlayerSchema = z.object({
  playerId: z.number(),
  imageId: z.number().optional(), // needed for optimistic update
  reason: z.string().optional(),
  size: z.number().optional().default(newOrderConfig.smiteSize),
});

export type CleanseSmiteInput = z.infer<typeof cleanseSmiteSchema>;
export const cleanseSmiteSchema = z.object({
  id: z.number(),
  cleansedReason: z.string(),
  playerId: z.number(),
});

export type AddImageRatingInput = z.infer<typeof addImageRatingSchema>;
export const addImageRatingSchema = z.object({
  imageId: z.number(),
  rating: z.enum(NsfwLevel),
  damnedReason: z.enum(NewOrderDamnedReason).optional(),
});

export type AddSanityCheckRatingInput = z.infer<typeof addSanityCheckRatingSchema>;
export const addSanityCheckRatingSchema = z.object({
  imageId: z.number(),
  rating: z.enum(NsfwLevel),
});

const transformStatus = {
  [NewOrderImageRatingStatus.AcolyteCorrect]: [
    NewOrderImageRatingStatus.AcolyteCorrect,
    NewOrderImageRatingStatus.Correct,
  ],
  [NewOrderImageRatingStatus.AcolyteFailed]: [
    NewOrderImageRatingStatus.AcolyteFailed,
    NewOrderImageRatingStatus.Failed,
  ],
  [NewOrderImageRatingStatus.Correct]: [
    NewOrderImageRatingStatus.Correct,
    NewOrderImageRatingStatus.AcolyteCorrect,
  ],
  [NewOrderImageRatingStatus.Failed]: [
    NewOrderImageRatingStatus.Failed,
    NewOrderImageRatingStatus.AcolyteFailed,
  ],
  [NewOrderImageRatingStatus.Pending]: [NewOrderImageRatingStatus.Pending],
  [NewOrderImageRatingStatus.Inconclusive]: [NewOrderImageRatingStatus.Inconclusive],
} as const;

export type GetHistoryInput = z.input<typeof getHistorySchema>;
export type GetHistorySchema = z.infer<typeof getHistorySchema>;
// Keyset-pagination cursor: composite (createdAt, imageId) on the aggregated sort
// key. Both fields are typed/validated before they're interpolated into the
// ClickHouse query downstream — createdAt coerces to a real Date, imageId to a
// number — so a crafted string cannot inject SQL. (Prior bug: a `' OR 1=1 --`
// string cursor round-tripped untouched into the `createdAt < '${cursor}'`
// template, letting any authed user read every KoNo player's history.)
export const getHistorySchema = z.object({
  limit: z.number().optional().default(DEFAULT_PAGE_SIZE),
  cursor: z
    .object({
      // ClickHouse (JSONEachRow) serializes this DateTime as a bare
      // "YYYY-MM-DD HH:MM:SS" with no zone; coercing that with `new Date()` would
      // parse it as POD-LOCAL time. Force UTC so the keyset boundary is exact
      // regardless of pod TZ (pods are UTC today — don't silently depend on it).
      // An ISO/Z string or a Date instance passes through unchanged; anything
      // unparseable fails z.coerce.date() → .catch() below → page 1.
      createdAt: z.preprocess(
        (v) =>
          typeof v === 'string' && !/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? `${v.replace(' ', 'T')}Z` : v,
        z.coerce.date()
      ),
      imageId: z.number(),
    })
    .optional()
    // A legacy (pre-deploy, Date-shaped) or otherwise-invalid cursor degrades to
    // page 1 instead of a hard 400 — graceful across the canary window — and a
    // crafted cursor can never reach the query (dropped here, never interpolated).
    .catch(undefined),
  status: z
    .enum(NewOrderImageRatingStatus)
    .transform((val) => {
      return transformStatus[val] ?? undefined;
    })
    .optional(),
});

export type ResetPlayerByIdInput = z.infer<typeof resetPlayerByIdSchema>;
export const resetPlayerByIdSchema = z.object({
  playerId: z.number(),
});

export type GetImageRatersInput = z.infer<typeof getImageRatersSchema>;
export const getImageRatersSchema = z.object({
  imageId: z.number(),
});

export type ManageSanityChecksInput = z.infer<typeof manageSanityChecksSchema>;
export const manageSanityChecksSchema = z.object({
  add: z.array(z.number()).optional(),
  remove: z.array(z.number()).optional(),
});

