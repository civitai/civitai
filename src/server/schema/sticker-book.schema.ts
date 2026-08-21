import { z } from 'zod';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

export type GetStickerBookInput = z.infer<typeof getStickerBookSchema>;
export const getStickerBookSchema = z.object({
  username: z.string(),
  /** As every image listing takes it; clamped by the domain on the server. */
  browsingLevel: z.number().min(0).default(allBrowsingLevelsFlag),
  limit: z.number().min(1).max(60).optional(),
});
