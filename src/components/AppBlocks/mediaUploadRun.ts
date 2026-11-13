import { IMAGE_PREP_ERROR, ImagePrepError } from '~/shared/utils/canvas-utils';
import { ConsumerBlobUploadError, uploadConsumerBlob } from '~/utils/consumer-blob-upload';
import { uploadGenerationSourceImage } from './generationSourceImageUpload';
import {
  MEDIA_UPLOAD_FAILED_ERROR,
  MEDIA_UPLOAD_NO_VIDEO_TRACK_ERROR,
  MEDIA_UPLOAD_UNREADABLE_ERROR,
  type BlockMediaUploadInfo,
  type MediaUploadKind,
} from './mediaUploadLogic';

const PROBE_TIMEOUT_MS = 15_000;

const MEDIA_UPLOAD_BLOCKED_ERROR = {
  video: 'this video was refused by the upload service',
  audio: 'this audio was refused by the upload service',
};

/** A refusal whose message is written for the block and the viewer. */
export class MediaUploadError extends Error {
  name = 'MediaUploadError';
}

function once(el: HTMLMediaElement, ok: string, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      el.removeEventListener(ok, onOk);
      el.removeEventListener('error', onError);
      resolve(value);
    };
    const onOk = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    el.addEventListener(ok, onOk);
    el.addEventListener('error', onError);
  });
}

/**
 * A MediaRecorder WebM has no duration in its header, so the element reports `Infinity` until it
 * has seeked to the end. `undefined` when that does not resolve it either.
 */
async function resolveDuration(el: HTMLMediaElement): Promise<number | undefined> {
  if (Number.isFinite(el.duration)) return el.duration;
  const changed = once(el, 'durationchange', PROBE_TIMEOUT_MS);
  el.currentTime = Number.MAX_SAFE_INTEGER;
  await changed;
  return Number.isFinite(el.duration) ? el.duration : undefined;
}

/** Decode the file's metadata in a media element: a file the browser cannot play is refused. */
export async function probeMedia(
  kind: 'video' | 'audio',
  blob: Blob
): Promise<{ width?: number; height?: number; durationMs?: number }> {
  const el = document.createElement(kind);
  el.preload = 'metadata';
  el.muted = true;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const loaded = once(el, 'loadedmetadata', PROBE_TIMEOUT_MS);
    el.src = objectUrl;
    if (!(await loaded)) throw new MediaUploadError(MEDIA_UPLOAD_UNREADABLE_ERROR[kind]);
    const duration = await resolveDuration(el);
    const durationMs = duration === undefined ? undefined : Math.round(duration * 1000);
    if (kind === 'audio') return { durationMs };
    const video = el as HTMLVideoElement;
    if (!video.videoWidth || !video.videoHeight) {
      throw new MediaUploadError(MEDIA_UPLOAD_NO_VIDEO_TRACK_ERROR);
    }
    return { width: video.videoWidth, height: video.videoHeight, durationMs };
  } finally {
    el.removeAttribute('src');
    el.load();
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
