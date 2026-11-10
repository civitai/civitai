import type { AudioMetadata } from '~/server/schema/media.schema';
import {
  probeMediaElement,
  releaseMediaElement,
} from '~/utils/media-preprocessors/media-element-probe';

const errorMessage = 'Failed to load audio. This may indicate that the file is not playable.';

async function getAudioDuration(src: string) {
  const probed = await probeMediaElement('audio', src);
  if (!probed) throw new Error(errorMessage);
  releaseMediaElement(probed.element);
  if (probed.duration === undefined) throw new Error(errorMessage);
  return probed.duration;
}

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
