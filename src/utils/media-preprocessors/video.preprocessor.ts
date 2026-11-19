import pLimit from 'p-limit';
import type { VideoMetadata } from '~/server/schema/media.schema';
import { createBlurHash } from '~/utils/blurhash';
import { getVideoMetadata } from '~/utils/metadata';

const hasAudio = (video: any): boolean => {
  return (
    video.mozHasAudio ||
    Boolean(video.webkitAudioDecodedByteCount) ||
    Boolean(video.audioTracks && video.audioTracks.length)
  );
};

const errorMessage =
  'Failed to load video. This may indicate that the file is poorly encoded for use on the web.';

// A stuck seek may fire neither seeked nor error; without this limit the upload's loading state never ends.
export const SEEK_TIMEOUT_MS = 15000;

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(errorMessage), SEEK_TIMEOUT_MS);
    video.onseeked = () => {
      clearTimeout(timer);
      resolve();
    };
    video.onerror = () => {
      clearTimeout(timer);
      reject(errorMessage);
    };
    video.currentTime = time;
  });
}

export const getVideoData = async <T = HTMLVideoElement>(
  src: string,
  cb?: (video: HTMLVideoElement) => T
) =>
  new Promise<T>((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';

    let resolved = false;
    const tryResolve = () => {
      if (resolved) return;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        resolved = true;
        resolve(cb?.(video) ?? (video as T));
      }
    };

    // loadeddata fires when the first frame is available, guaranteeing dimensions
    video.onloadeddata = tryResolve;
    // Also try on loadedmetadata as a faster path when dimensions are ready early
    video.onloadedmetadata = tryResolve;

    // A load given up on still decodes until its source is cleared.
    const fail = () => {
      if (resolved) return;
      resolved = true;
      video.removeAttribute('src');
      video.load();
      reject(errorMessage);
    };
    video.onerror = fail;

    // Timeout fallback for edge cases
    setTimeout(fail, 10000);

    video.src = src;
  });

// Each video decodes in its own <video> under the load and seek limits above. Started together, the
// last of a large pick wait on the first in the browser's media pipeline while their limits run,
// and a video past its limit is dropped from the upload.
const decodeLimit = pLimit(2);

export const preprocessVideo = (file: File) => decodeLimit(() => decodeVideo(file));

async function decodeVideo(file: File) {
  const objectUrl = URL.createObjectURL(file);
  const [video, meta] = await Promise.all([getVideoData(objectUrl), getVideoMetadata(file)]);
  try {
    const width = video.videoWidth;
    const height = video.videoHeight;
    const duration = Math.round(video.duration * 1000) / 1000;
    const audio = hasAudio(video);

    // Seek to a representative frame to avoid black intro frames.
    // The seeked event guarantees decoded frame data is available for canvas drawing.
    const seekTime = Math.min(1, video.duration * 0.1);
    await seekVideo(video, seekTime);

    const hash = createBlurHash(video, width, height);

    const metadata: VideoMetadata = { width, height, hash, duration, audio };

    return {
      objectUrl,
      metadata: {
        size: file.size,
        ...metadata,
      },
      meta,
    };
  } finally {
    // Frees the decoder now rather than at garbage collection, so the next video gets it.
    video.removeAttribute('src');
    video.load();
  }
}
