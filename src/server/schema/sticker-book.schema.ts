import { z } from 'zod';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

export type GetStickerBookSectionInput = z.infer<typeof getStickerBookSectionSchema>;
export const getStickerBookSectionSchema = z.object({
  username: z.string(),
  /** `placer` is "images they stickered"; `owner` is "their images that got stickered". */
  side: z.enum(['placer', 'owner']),
  page: z.number().min(1).max(200).optional(),
  browsingLevel: z.number().min(0).default(allBrowsingLevelsFlag),
});

export type GetStickerBookInput = z.infer<typeof getStickerBookSchema>;
export const getStickerBookSchema = z.object({
  username: z.string(),
  /** As every image listing takes it; clamped by the domain on the server. */
  browsingLevel: z.number().min(0).default(allBrowsingLevelsFlag),
  limit: z.number().min(1).max(60).optional(),
});
