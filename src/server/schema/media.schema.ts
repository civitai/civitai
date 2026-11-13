import * as z from 'zod';
import { POST_TITLE_MAX_LENGTH, SONG_KEY_MAX_LENGTH } from '~/server/common/constants';

const sharedMetadata = z.object({
  height: z.number(),
  width: z.number(),
  hash: z.string().optional(),
  size: z.number().optional(),
  ruleId: z.number().optional(),
  ruleReason: z.string().optional(),
  remixSourceReviewed: z.boolean().optional(),
  profilePicture: z.boolean().optional(),
  coverImage: z.boolean().optional(),
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

/** One line of a song's lyrics: `t` is its offset in milliseconds, or null when not synced. */
export type LyricLine = z.infer<typeof lyricLineSchema>;
export const lyricLineSchema = z.object({
  t: z.number().int().min(0).nullable(),
  text: z.string(),
});

export type AudioMetadata = z.infer<typeof audioMetadataSchema>;
export const audioMetadataSchema = sharedMetadata.partial({ height: true, width: true }).extend({
  duration: z.number(),
  title: z.string().max(POST_TITLE_MAX_LENGTH).optional(),
  /**
   * Sent by the client and discarded by the server: a song's lyrics are in `TrackLyrics`. Loose, so
   * a client's own timing never rejects the post.
   */
  lyrics: z.array(z.object({ t: z.number().nullable(), text: z.string() })).optional(),
  bpm: z.number().optional(),
  key: z.string().max(SONG_KEY_MAX_LENGTH).optional(),
  coverImageId: z.number().optional(),
  /** Absent means remixing is allowed. */
  allowRemix: z.boolean().optional(),
});

export type MediaMetadata = ImageMetadata | VideoMetadata | AudioMetadata;
