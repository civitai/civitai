import { MediaType } from '@prisma/client';

export const MIME_TYPES = {
  // Images
  png: 'image/png',
  jpg: 'image/jpg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',

  // Video
  mp4: 'video/mp4',
  webm: 'video/webm',

  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/vnd.wave',

  // Zip
  zip: 'application/zip',
  xZipCompressed: 'application/x-zip-compressed',
  xZipMultipart: 'multipart/x-zip',
} as const;

export const MEDIA_TYPE: Record<string, MediaType> = {
  [MIME_TYPES.png]: MediaType.image,
  [MIME_TYPES.jpeg]: MediaType.image,
  [MIME_TYPES.jpg]: MediaType.image,
  [MIME_TYPES.webp]: MediaType.image,
  [MIME_TYPES.mp4]: MediaType.video,
  [MIME_TYPES.webm]: MediaType.video,
  [MIME_TYPES.mp3]: MediaType.audio,
  [MIME_TYPES.wav]: MediaType.audio,
} as const;

export const IMAGE_MIME_TYPE = [MIME_TYPES.png, MIME_TYPES.jpeg, MIME_TYPES.jpg, MIME_TYPES.webp];
export type IMAGE_MIME_TYPE = (typeof IMAGE_MIME_TYPE)[number];
export const VIDEO_MIME_TYPE = [MIME_TYPES.mp4, MIME_TYPES.webm];
export const AUDIO_MIME_TYPE = [MIME_TYPES.mp3, MIME_TYPES.wav];
export const ZIP_MIME_TYPE = [MIME_TYPES.zip, MIME_TYPES.xZipCompressed, MIME_TYPES.xZipMultipart];
