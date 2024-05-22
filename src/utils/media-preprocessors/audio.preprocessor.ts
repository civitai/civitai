import { EXTENSION_BY_MIME_TYPE } from '~/server/common/mime-types';
import { AudioMetadata } from '~/server/schema/media.schema';

function getAudioData(src: string) {
  return new Promise<AudioMetadata>((resolve) => {
    const audio = new Audio(src);
    audio.onloadedmetadata = () => {
      audio.duration;
      resolve({
        duration: Math.round(audio.duration * 1000) / 1000,
      });
    };
  });
}

export async function preprocessAudio(file: File) {
  const objectUrl = URL.createObjectURL(file);
  const metadata = await getAudioData(objectUrl);

  return {
    objectUrl,
    metadata: {
      size: file.size,
      format: EXTENSION_BY_MIME_TYPE[file.type],
      ...metadata,
    },
  };
}
