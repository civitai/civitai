import { MEDIA_TYPE } from '~/server/common/mime-types';
import { preprocessImage } from '~/utils/media-preprocessors/image.preprocessor';
import { preprocessVideo } from '~/utils/media-preprocessors/video.preprocessor';

export * from './image.preprocessor';
export * from './video.preprocessor';

type SharedProps = { name: string; mimeType: string };
type ProcessedImage = { type: 'image' } & AsyncReturnType<typeof preprocessImage>;
type ProcessedVideo = { type: 'video' } & AsyncReturnType<typeof preprocessVideo>;

export type PreprocessFileReturnType = SharedProps & (ProcessedImage | ProcessedVideo);

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
    default:
      throw new Error(`unhandled file type: ${file.name.split('.').pop()}`);
  }
}
