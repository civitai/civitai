import * as z from 'zod';

/** One image per request, so the per-request rate limits count images. */
export const STUDIO_DATASET_RATING_BATCH = 1;

export type StudioDatasetRatingInput = z.infer<typeof studioDatasetRatingSchema>;
export const studioDatasetRatingSchema = z.object({
  items: z
    .array(
      z.object({
        mediaUrl: z
          .url()
          .max(2048)
          .refine((u) => u.startsWith('https://'), { message: 'mediaUrl must be HTTPS' }),
        key: z.string().min(1).max(256),
      })
    )
    .min(1)
    .max(STUDIO_DATASET_RATING_BATCH)
    .refine((items) => new Set(items.map((i) => i.key)).size === items.length, {
      message: 'Duplicate key in batch',
    }),
  /** The level the caller will cache the verdicts under. */
  matureLevel: z.number().int().min(1).max(4),
});
