import * as z from 'zod';

const sharedMetadata = z.object({
  height: z.number(),
  width: z.number(),
  hash: z.string().optional(),
  size: z.number().optional(),
  ruleId: z.number().optional(),
  ruleReason: z.string().optional(),
  profilePicture: z.boolean().optional(),
  username: z.string().optional(),
  userId: z.number().optional(),
  nsfwLevelReason: z.string().nullish(),
});

export type ImageMetadata = z.infer<typeof imageMetadataSchema>;
export const imageMetadataSchema = sharedMetadata.extend({});

export type VideoMetadata = z.infer<typeof videoMetadataSchema>;
export const videoMetadataSchema = sharedMetadata.extend({
  duration: z.number().optional(),
  audio: z.boolean().optional(),
  thumbnailFrame: z.number().nullish(),
  youtubeVideoId: z.string().optional(),
  youtubeUploadAttempt: z.number().optional(),
  youtubeUploadEnqueuedAt: z.string().optional(),
  vimeoVideoId: z.string().optional(),
  vimeoUploadAttempt: z.number().optional(),
  vimeoUploadEnqueuedAt: z.string().optional(),
  thumbnailId: z.number().optional(),
  parentId: z.number().optional(),
  // hasSound: z.boolean().default(false), not accessible from HTMLVideoElement
});

export type MediaMetadata = ImageMetadata | VideoMetadata;
