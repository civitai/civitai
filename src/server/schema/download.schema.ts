import * as z from 'zod';

export const hideDownloadInput = z.object({
  modelVersionId: z.number().optional(),
  all: z.boolean().optional(),
});
export type HideDownloadInput = z.infer<typeof hideDownloadInput>;
