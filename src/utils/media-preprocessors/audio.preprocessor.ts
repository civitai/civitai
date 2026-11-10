import type { AudioMetadata } from '~/server/schema/media.schema';

const errorMessage = 'Failed to load audio. This may indicate that the file is not playable.';
const LOAD_TIMEOUT_MS = 10000;

const getAudioDuration = (src: string) =>
  new Promise<number>((resolve, reject) => {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';

    const timeout = setTimeout(() => reject(new Error(errorMessage)), LOAD_TIMEOUT_MS);
    audio.onloadedmetadata = () => {
      clearTimeout(timeout);
      if (Number.isFinite(audio.duration)) resolve(audio.duration);
      else reject(new Error(errorMessage));
    };
    audio.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(errorMessage));
    };

    audio.src = src;
  });

export const preprocessAudio = async (file: File) => {
  const objectUrl = URL.createObjectURL(file);
  let duration: number;
  try {
    duration = Math.round((await getAudioDuration(objectUrl)) * 1000) / 1000;
  } catch (e) {
    URL.revokeObjectURL(objectUrl);
    throw e;
  }

  const metadata: AudioMetadata = { size: file.size, duration };
  return { objectUrl, metadata, meta: undefined };
};
