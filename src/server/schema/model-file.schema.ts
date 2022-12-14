import { ModelFileType } from '@prisma/client';
import { z } from 'zod';

export const modelFileSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  url: z.string().url().min(1, 'You must select a file'),
  sizeKB: z.number(),
  type: z.nativeEnum(ModelFileType),
  primary: z.boolean().default(false),
});

export type ModelFileInput = z.infer<typeof modelFileSchema>;
