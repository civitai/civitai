import { MEDIA_TYPE } from '~/shared/constants/mime-types';
import { preprocessAudio } from '~/utils/media-preprocessors/audio.preprocessor';
import { preprocessImage } from '~/utils/media-preprocessors/image.preprocessor';
import { preprocessVideo } from '~/utils/media-preprocessors/video.preprocessor';

export { auditImageMeta } from './image.preprocessor';
export { getVideoData } from './video.preprocessor';

type SharedProps = { name: string; mimeType: string };
type ProcessedImage = { type: 'image' } & AsyncReturnType<typeof preprocessImage>;
type ProcessedVideo = { type: 'video' } & AsyncReturnType<typeof preprocessVideo>;
type ProcessedAudio = { type: 'audio' } & AsyncReturnType<typeof preprocessAudio>;

export type PreprocessFileReturnType = SharedProps &
  (ProcessedImage | ProcessedVideo | ProcessedAudio);

export type PreprocessFileOptions = {
  allowAnimatedWebP?: boolean;
  /**
   * The file is a generated song. It is probed as audio even in a video container (ACE muxes the
   * cover into the file). Without it audio is refused before it is probed: nothing uploads audio
   * as a free-standing file.
   */
  asAudio?: boolean;
};

export async function preprocessFile(
  file: File,
  options?: PreprocessFileOptions
): Promise<PreprocessFileReturnType> {
  let fileType = file.type;
  if (fileType === 'application/octet-stream') fileType = 'video/mp4';
  const mediaType = MEDIA_TYPE[fileType];
  const type =
    options?.asAudio && (mediaType === 'audio' || mediaType === 'video') ? 'audio' : mediaType;
  if (type === 'audio' && !options?.asAudio)
    throw new Error('Audio uploads are not supported yet.');
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
    case 'audio':
      const audioData = await preprocessAudio(file);
      return { type, ...data, ...audioData };
    default:
      throw new Error(`Unhandled file type: ${file.name.split('.').pop() as string}`);
  }
}
