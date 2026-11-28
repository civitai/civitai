import { MEDIA_TYPE } from '~/shared/constants/mime-types';
import { preprocessImage } from '~/utils/media-preprocessors/image.preprocessor';
import { preprocessVideo } from '~/utils/media-preprocessors/video.preprocessor';

export { auditImageMeta } from './image.preprocessor';
export { getVideoData } from './video.preprocessor';

type SharedProps = { name: string; mimeType: string };
type ProcessedImage = { type: 'image' } & AsyncReturnType<typeof preprocessImage>;
type ProcessedVideo = { type: 'video' } & AsyncReturnType<typeof preprocessVideo>;

export type PreprocessFileReturnType = SharedProps & (ProcessedImage | ProcessedVideo);

/** The mime type a file is uploaded as: an untyped download is read as an mp4. */
export const uploadMimeType = (file: File) =>
  file.type === 'application/octet-stream' ? 'video/mp4' : file.type;

export async function preprocessFile(
  file: File,
  options?: { allowAnimatedWebP?: boolean }
): Promise<PreprocessFileReturnType> {
  const fileType = uploadMimeType(file);
  const type = MEDIA_TYPE[fileType];
  const data = {
    name: file.name,
    mimeType: fileType,
  };

  switch (type) {
    case 'image':
      const imageData = await preprocessImage(file, options);
      return { type, ...data, ...imageData };
    case 'video':
      const videoData = await preprocessVideo(file);
      return { type, ...data, ...videoData };
    default:
      throw new Error(`Unhandled file type: ${file.name.split('.').pop() as string}`);
  }
}
