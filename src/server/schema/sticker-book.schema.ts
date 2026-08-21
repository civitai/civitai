import { z } from 'zod';

export type GetStickerBookSectionInput = z.infer<typeof getStickerBookSectionSchema>;
export const getStickerBookSectionSchema = z.object({
  username: z.string(),
  /** `placer` is "images they stickered"; `owner` is "their images that got stickered". */
  side: z.enum(['placer', 'owner']),
  page: z.number().min(1).max(200).optional(),
});

export type GetStickerBookInput = z.infer<typeof getStickerBookSchema>;
/**
 * No browsing level, deliberately: this returns image IDS and no image payload.
 * The page hands those to `image.getInfinite`, which is where the browsing
 * level, the domain ceiling, the publish rules and the viewer's hidden
 * preferences are all already applied — one gate rather than a second, weaker
 * copy of it here.
 */
export const getStickerBookSchema = z.object({
  username: z.string(),
  limit: z.number().min(1).max(60).optional(),
});
