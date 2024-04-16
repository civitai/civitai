import { z } from 'zod';

import { getAllQuerySchema } from '~/server/schema/base.schema';

export const getUserDownloadsSchema = getAllQuerySchema.extend({
  cursor: z.date(),
  unread: z.boolean().default(false),
});
export type GetUserDownloadsSchema = z.infer<typeof getUserDownloadsSchema>;

export const hideDownloadInput = z.object({
  modelVersionId: z.number().optional(),
  all: z.boolean().optional(),
});
export type HideDownloadInput = z.infer<typeof hideDownloadInput>;
