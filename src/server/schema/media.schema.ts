import { z } from 'zod';

export type ImageMetadata = z.infer<typeof imageMetadataSchema>;
export const imageMetadataSchema = z.object({
  height: z.number(),
  width: z.number(),
  hash: z.string().optional(),
  size: z.number().optional(),
});

export type VideoMetadata = z.infer<typeof videoMetadataSchema>;
export const videoMetadataSchema = z.object({
  height: z.number(),
  width: z.number(),
  hash: z.string().optional(), // first frame of video
  duration: z.number().optional(),
  audio: z.boolean().optional(),
  size: z.number().optional(),
  // hasSound: z.boolean().default(false), not accessible from HTMLVideoElement
});

export type AudioMetadata = z.infer<typeof audioMetadataSchema>;
export const audioMetadataSchema = z.object({
  duration: z.number(),
  size: z.number(),
  format: z.string().optional(),
  peaks: z.array(z.number().array()).optional(),
});
