import { MediaType } from '~/shared/utils/prisma/enums';

export const MIME_TYPES = {
  // Images
  png: 'image/png',
  // Note: 'image/jpg' is not a valid MIME type - the correct type is 'image/jpeg'
  // We use 'image/jpeg' for both .jpg and .jpeg extensions
  jpg: 'image/jpeg',
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
  [MIME_TYPES.jpeg]: MediaType.image, // Also covers MIME_TYPES.jpg since they're both 'image/jpeg'
  [MIME_TYPES.webp]: MediaType.image,
  [MIME_TYPES.mp4]: MediaType.video,
  [MIME_TYPES.webm]: MediaType.video,
  [MIME_TYPES.mp3]: MediaType.audio,
  [MIME_TYPES.wav]: MediaType.audio,
} as const;

// Note: MIME_TYPES.jpg and MIME_TYPES.jpeg are both 'image/jpeg', so we only include it once
export const IMAGE_MIME_TYPE = [MIME_TYPES.png, MIME_TYPES.jpeg, MIME_TYPES.webp];
export type IMAGE_MIME_TYPE = (typeof IMAGE_MIME_TYPE)[number];
export const VIDEO_MIME_TYPE = [MIME_TYPES.mp4, MIME_TYPES.webm];
export const AUDIO_MIME_TYPE = [MIME_TYPES.mp3, MIME_TYPES.wav];
export const ZIP_MIME_TYPE = [MIME_TYPES.zip, MIME_TYPES.xZipCompressed, MIME_TYPES.xZipMultipart];

export function getMimeTypeFromExt(ext: string) {
  return MIME_TYPES[ext as keyof typeof MIME_TYPES];
}

const MediaTypeDictionary = {
  [MediaType.image]: IMAGE_MIME_TYPE,
  [MediaType.video]: VIDEO_MIME_TYPE,
  [MediaType.audio]: AUDIO_MIME_TYPE,
};

export function getMimeTypesFromMediaTypes(types: MediaType[]) {
  const arr: string[] = [];
  for (const type of types) {
    arr.push(...MediaTypeDictionary[type]);
  }
  return arr;
}

const mimeToExtension: Record<string, string> = Object.entries(MIME_TYPES).reduce(
  (acc, [ext, mime]) => {
    if (!acc[mime]) acc[mime] = ext.toUpperCase();
    return acc;
  },
  {} as Record<string, string>
);

/** Converts MIME types to human-readable extensions (e.g. ["image/png", "image/jpeg"] → "PNG, JPEG") */
export function getExtensionsFromMimeTypes(mimeTypes: string[]): string {
  return [...new Set(mimeTypes.map((mime) => mimeToExtension[mime] ?? mime))].join(', ');
}
