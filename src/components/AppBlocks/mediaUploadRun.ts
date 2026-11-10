import { IMAGE_PREP_ERROR, ImagePrepError } from '~/shared/utils/canvas-utils';
import { ConsumerBlobUploadError, uploadConsumerBlob } from '~/utils/consumer-blob-upload';
import {
  probeMediaElement,
  releaseMediaElement,
} from '~/utils/media-preprocessors/media-element-probe';
import { uploadGenerationSourceImage } from './generationSourceImageUpload';
import {
  MEDIA_UPLOAD_FAILED_ERROR,
  MEDIA_UPLOAD_NO_VIDEO_TRACK_ERROR,
  MEDIA_UPLOAD_UNREADABLE_ERROR,
  type BlockMediaUploadInfo,
  type MediaUploadKind,
} from './mediaUploadLogic';

const MEDIA_UPLOAD_BLOCKED_ERROR = {
  video: 'this video was refused by the upload service',
  audio: 'this audio was refused by the upload service',
};

/** A refusal whose message is written for the block and the viewer. */
export class MediaUploadError extends Error {
  name = 'MediaUploadError';
}

/** Decode the file's metadata in a media element: a file the browser cannot play is refused. */
export async function probeMedia(
  kind: 'video' | 'audio',
  blob: Blob
): Promise<{ width?: number; height?: number; durationMs?: number }> {
  const objectUrl = URL.createObjectURL(blob);
  let el: HTMLMediaElement | undefined;
  try {
    const probed = await probeMediaElement(kind, objectUrl);
    el = probed?.element;
    if (!probed) throw new MediaUploadError(MEDIA_UPLOAD_UNREADABLE_ERROR[kind]);
    const { duration } = probed;
    const durationMs = duration === undefined ? undefined : Math.round(duration * 1000);
    if (kind === 'audio') return { durationMs };
    const video = probed.element as HTMLVideoElement;
    if (!video.videoWidth || !video.videoHeight) {
      throw new MediaUploadError(MEDIA_UPLOAD_NO_VIDEO_TRACK_ERROR);
    }
    return { width: video.videoWidth, height: video.videoHeight, durationMs };
  } finally {
    if (el) releaseMediaElement(el);
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Validate in the browser, then upload as a private consumer blob. `contentType` is the sniffed
 * one. `null` when `isCurrent` turned false during an image upload (its read-back is skipped).
 */
export async function uploadGenerationMedia(
  kind: MediaUploadKind,
  file: Blob,
  contentType: string,
  isCurrent: () => boolean = () => true
): Promise<BlockMediaUploadInfo | null> {
  if (kind === 'image') {
    const image = await uploadGenerationSourceImage(file, isCurrent);
    if (!image) return null;
    const { url, width, height, sizeBytes } = image;
    return { url, kind, mimeType: 'image/jpeg', sizeBytes, width, height };
  }
  const probed = await probeMedia(kind, file);
  const body = file.type === contentType ? file : new Blob([file], { type: contentType });
  const blob = await uploadConsumerBlob(body);
  if (blob.blockedReason || blob.available === false) {
    throw new MediaUploadError(MEDIA_UPLOAD_BLOCKED_ERROR[kind]);
  }
  const { url } = blob;
  if (!url) throw new Error('Upload did not return a URL');
  const info: BlockMediaUploadInfo = { url, kind, mimeType: contentType, sizeBytes: body.size };
  if (probed.width !== undefined) info.width = probed.width;
  if (probed.height !== undefined) info.height = probed.height;
  if (probed.durationMs !== undefined) info.durationMs = probed.durationMs;
  return info;
}

/**
 * The refusal text for a failed upload. A blob POST's error embeds the upload server's response
 * body, and a presign 4xx relays upstream text written for the viewer; neither is the block's to
 * read, so both get a fixed message.
 */
export function mediaUploadErrorMessage(err: unknown): string {
  if (err instanceof ImagePrepError) return IMAGE_PREP_ERROR;
  if (err instanceof ConsumerBlobUploadError) {
    if (err.kind === 'presign-http-401') return 'Sign in to upload media.';
    if (err.kind.startsWith('http-') || err.kind.startsWith('presign-http-')) {
      return MEDIA_UPLOAD_FAILED_ERROR;
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return 'media upload failed — please try again';
}
