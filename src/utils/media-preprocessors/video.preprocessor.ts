import type { VideoMetadata } from '~/server/schema/media.schema';
import { createBlurHash } from '~/utils/blurhash';

const hasAudio = (video: any): boolean => {
  return (
    video.mozHasAudio ||
    Boolean(video.webkitAudioDecodedByteCount) ||
    Boolean(video.audioTracks && video.audioTracks.length)
  );
};

function getVideoMetadata(video: HTMLVideoElement): VideoMetadata {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const audio = hasAudio(video);
  return {
    width,
    height,
    hash: createBlurHash(video, width, height),
    duration: Math.round(video.duration * 1000) / 1000,
    audio,
  };
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
  const metadata = await getVideoData(objectUrl, getVideoMetadata);

  return {
    objectUrl,
    metadata: {
      size: file.size,
      ...metadata,
    },
  };
};
