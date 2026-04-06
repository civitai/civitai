import type { VideoMetadata } from '~/server/schema/media.schema';
import { createBlurHash } from '~/utils/blurhash';

const hasAudio = (video: any): boolean => {
  return (
    video.mozHasAudio ||
    Boolean(video.webkitAudioDecodedByteCount) ||
    Boolean(video.audioTracks && video.audioTracks.length)
  );
};

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    video.onseeked = () => resolve();
    video.currentTime = time;
  });
}

const errorMessage =
  'Failed to load video. This may indicate that the file is poorly encoded for use on the web.';
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

    video.onerror = () => {
      if (!resolved) reject(errorMessage);
    };

    // Timeout fallback for edge cases
    setTimeout(() => {
      if (!resolved) reject(errorMessage);
    }, 10000);

    video.src = src;
  });

export const preprocessVideo = async (file: File) => {
  const objectUrl = URL.createObjectURL(file);
  const video = await getVideoData(objectUrl);

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
  };
};
