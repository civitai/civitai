import { z } from 'zod';

export const imageMetadataSchema = z.object({
  height: z.number().optional(),
  width: z.number().optional(),
  hash: z.string().optional(),
});

export const videoMetadataSchema = z.object({
  height: z.number().optional(),
  width: z.number().optional(),
  hash: z.string().optional(), // first frame of video
  duration: z.number().optional(),
  hasSound: z.boolean().default(false),
});
