import { MEDIA_TYPE } from '~/server/common/mime-types';
import { preprocessAudio } from '~/utils/media-preprocessors/audio.preprocessor';
import { preprocessImage } from '~/utils/media-preprocessors/image.preprocessor';
import { preprocessVideo } from '~/utils/media-preprocessors/video.preprocessor';

export * from './image.preprocessor';
export * from './video.preprocessor';

type SharedProps = { name: string; mimeType: string };
type ProcessedImage = { type: 'image' } & AsyncReturnType<typeof preprocessImage>;
type ProcessedVideo = { type: 'video' } & AsyncReturnType<typeof preprocessVideo>;
type ProcessedAudio = { type: 'audio' } & AsyncReturnType<typeof preprocessAudio>;

export type PreprocessFileReturnType = SharedProps &
  (ProcessedImage | ProcessedVideo | ProcessedAudio);

export async function preprocessFile(file: File): Promise<PreprocessFileReturnType> {
  const type = MEDIA_TYPE[file.type];
  const data = {
    name: file.name,
    mimeType: file.type,
  };

  switch (type) {
    case 'image':
      const imageData = await preprocessImage(file);
      return { type, ...data, ...imageData };
    case 'video':
      const videoData = await preprocessVideo(file);
      return { type, ...data, ...videoData };
    case 'audio':
      const audioData = await preprocessAudio(file);
      return { type, ...data, ...audioData };
    default:
      throw new Error(`unhandled file type: ${file.name.split('.').pop()}`);
  }
}
