export const MIME_TYPES = {
  // Images
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',

  // Video
  mp4: 'video/mp4',
  webm: 'video/webm',

  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/vnd.wave',
} as const;

export const IMAGE_MIME_TYPE = [MIME_TYPES.png, MIME_TYPES.jpeg, MIME_TYPES.webp];
export const VIDEO_MIME_TYPE = [MIME_TYPES.mp4, MIME_TYPES.webm];
export const AUDIO_MIME_TYPE = [MIME_TYPES.mp3, MIME_TYPES.wav];
