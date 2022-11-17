import { ModelFileType } from '@prisma/client';
import { z } from 'zod';

export const modelFileSchema = z.object({
  name: z.string(),
  url: z.string().url().min(1, 'You must select a file'),
  sizeKB: z.number(),
  type: z.nativeEnum(ModelFileType),
});

export type ModelFileProps = z.infer<typeof modelFileSchema>;
