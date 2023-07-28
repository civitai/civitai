import { MediaType } from '@prisma/client';
import { MEDIA_TYPE } from '~/server/common/mime-types';
import { preprocessImage } from '~/utils/media-preprocessors/image.preprocessor';
import { preprocessVideo } from '~/utils/media-preprocessors/video.preprocessor';

export * from './image.preprocessor';
export * from './video.preprocessor';

export const preprocessFile = async (file: File) => {
  const type = MEDIA_TYPE[file.type];
  const data = {
    type,
    name: file.name,
    mimeType: file.type,
  };

  // if(data.type === MediaType.image) {
  //   const imageData =

  // } else if (data.type === MediaType.video) {

  // } else
  // throw new Error('unhandled preprocessFile type');

  switch (data.type) {
    case MediaType.image:
      const imageData = await preprocessImage(file);
      return { ...data, ...imageData };
    case MediaType.video:
      const videoData = await preprocessVideo(file);
      return { ...data, ...videoData };
    default:
      throw new Error('unhandled preprocessFile type');
  }
};
