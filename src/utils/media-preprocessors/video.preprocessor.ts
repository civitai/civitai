import type { VideoMetadata } from '~/server/schema/media.schema';
import { createBlurHash } from '~/utils/blurhash';

const hasAudio = (video: any): boolean => {
  return (
    video.mozHasAudio ||
    Boolean(video.webkitAudioDecodedByteCount) ||
    Boolean(video.audioTracks && video.audioTracks.length)
  );
};

function getVideoMetadata(video: HTMLVideoElement) {
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

export const getVideoData = async (src: string) =>
  new Promise<VideoMetadata>((resolve, reject) => {
    const video = document.createElement('video');
    video.onloadedmetadata = function () {
      let timedOut = false;
      setTimeout(() => (timedOut = true), 3000);
      function check() {
        if (timedOut) reject('video preprocessing timed out');
        else if (video.videoWidth > 0 && video.videoHeight > 0) resolve(getVideoMetadata(video));
        else requestAnimationFrame(check);
      }
      check();
    };
    video.onerror = (...args) => reject(args);
    video.src = src;
  });

export const preprocessVideo = async (file: File) => {
  const objectUrl = URL.createObjectURL(file);
  const metadata = await getVideoData(objectUrl);

  return {
    objectUrl,
    metadata: {
      size: file.size,
      ...metadata,
    },
  };
};
