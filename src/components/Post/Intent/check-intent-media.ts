import { constants } from '~/server/common/constants';
import { IMAGE_MIME_TYPE, MEDIA_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import { createImageElement } from '~/utils/image-utils';
import { getVideoData } from '~/utils/media-preprocessors';
import { formatBytes } from '~/utils/number-helpers';

export type CheckedIntentMedia = { url: string; type: 'image' | 'video'; bytes: number };

type Deps = {
  fetchBlob: (url: string) => Promise<Blob>;
  loadImage: (objectUrl: string) => Promise<unknown>;
  readVideo: (objectUrl: string) => Promise<{ duration?: number; width: number; height: number }>;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (objectUrl: string) => void;
};

const defaultDeps: Deps = {
  fetchBlob: async (url) => (await fetch(url)).blob(),
  loadImage: createImageElement,
  readVideo: getVideoData,
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (objectUrl) => URL.revokeObjectURL(objectUrl),
};

/** Fetch one open-mode media url in the browser and check it against the site's upload limits. */
export async function checkIntentMedia(
  url: string,
  deps: Deps = defaultDeps
): Promise<CheckedIntentMedia> {
  let blob: Blob;
  try {
    blob = await deps.fetchBlob(url);
  } catch {
    throw new Error('Could not fetch media from that url');
  }
  if (!blob.type) throw new Error('Could not fetch media from that url');

  const type = MEDIA_TYPE[blob.type];
  if (type !== 'image' && type !== 'video')
    throw new Error(
      `Unsupported file type: "${blob.type}". Accepted types: ${[
        ...IMAGE_MIME_TYPE,
        ...VIDEO_MIME_TYPE,
      ].join(', ')}`
    );

  const { maxImageFileSize, maxVideoFileSize, maxVideoDurationSeconds, maxVideoDimension } =
    constants.mediaUpload;
  const maxBytes = type === 'image' ? maxImageFileSize : maxVideoFileSize;
  if (blob.size > maxBytes)
    throw new Error(
      `${type === 'image' ? 'Image' : 'Video'} (${formatBytes(
        blob.size
      )}) should not exceed ${formatBytes(maxBytes)}.`
    );

  const objectUrl = deps.createObjectUrl(blob);
  try {
    if (type === 'image') {
      await deps.loadImage(objectUrl).catch(() => {
        throw new Error('Could not read the image at that url');
      });
    } else {
      const video = await deps.readVideo(objectUrl).catch(() => {
        throw new Error('Could not read the video at that url');
      });
      if (video.duration && video.duration > maxVideoDurationSeconds)
        throw new Error(
          `Video duration cannot be longer than ${maxVideoDurationSeconds} seconds. Please trim your video and try again.`
        );
      if (video.width > maxVideoDimension || video.height > maxVideoDimension)
        throw new Error(
          `Videos cannot be larger than ${maxVideoDimension}px from either side. Please resize your video and try again.`
        );
    }
  } finally {
    deps.revokeObjectUrl(objectUrl);
  }
  return { url, type, bytes: blob.size };
}
