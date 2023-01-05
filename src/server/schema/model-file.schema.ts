import { z } from 'zod';
import { constants } from '~/server/common/constants';

export const modelFileSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  url: z.string().url().min(1, 'You must select a file'),
  sizeKB: z.number(),
  type: z.enum(constants.modelFileTypes),
});

export type ModelFileInput = z.infer<typeof modelFileSchema>;
