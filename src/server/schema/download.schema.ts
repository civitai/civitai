import { z } from 'zod';

import { getAllQuerySchema } from '~/server/schema/base.schema';

export const getUserDownloadsSchema = getAllQuerySchema.extend({
  cursor: z.string(),
  unread: z.boolean().default(false),
});
export type GetUserDownloadsSchema = z.infer<typeof getUserDownloadsSchema>;

export const hideDownloadInput = z.object({
  userId: z.number(),
  id: z.string().optional(),
  all: z.boolean().optional(),
});
export type hideDownloadInput = z.infer<typeof hideDownloadInput>;
