import ExifReader from 'exifreader';
import { v4 as uuidv4 } from 'uuid';
import { ImageMetaProps, imageMetaSchema } from '~/server/schema/image.schema';
import { automaticMetadataProcessor } from '~/utils/metadata/automatic.metadata';
import { comfyMetadataProcessor } from '~/utils/metadata/comfy.metadata';
import { isDefined } from '~/utils/type-guards';
import { auditImageMeta, preprocessFile } from '~/utils/media-preprocessors';
import { MediaType } from '@prisma/client';
import { showErrorNotification } from '~/utils/notifications';

const parsers = {
  automatic: automaticMetadataProcessor,
  comfy: comfyMetadataProcessor,
};

export async function getMetadata(file: File) {
  const tags = await ExifReader.load(file, { includeUnknown: true });
  delete tags['MakerNote'];
  const exif = Object.entries(tags).reduce((acc, [key, value]) => {
    acc[key] = value.value;
    return acc;
  }, {} as Record<string, any>); //eslint-disable-line

  if (exif.UserComment) {
    // @ts-ignore - this is a hack to not have to rework our downstream code
    exif.userComment = Int32Array.from(exif.UserComment);
  }

  let metadata = {};
  try {
    const { parse } = Object.values(parsers).find((x) => x.canParse(exif)) ?? {};
    if (parse) metadata = parse(exif);
  } catch (e: any) { //eslint-disable-line
    console.error('Error parsing metadata', e);
  }
  const result = imageMetaSchema.safeParse(metadata);
  return result.success ? result.data : {};
}

export function encodeMetadata(meta: ImageMetaProps, type: keyof typeof parsers = 'automatic') {
  return parsers[type]?.encode(meta);
}

export const parsePromptMetadata = async (generationDetails: string) => {
  return await automaticMetadataProcessor.parse({ generationDetails });
};

export const getImageDataFromFile = async (file: File) => {
  const processed = await preprocessFile(file);
  const { blockedFor } = await auditImageMeta(
    processed.type === MediaType.image ? processed.meta : undefined,
    false
  );
  if (processed.type === 'video') {
    const { metadata } = processed;
    try {
      if (metadata.duration && metadata.duration > 60)
        throw new Error('video duration can not be longer than 60s');
      if (metadata.width > 1920 || metadata.height > 1920)
        throw new Error('please reduce image dimensions');
    } catch (error: any) {
      showErrorNotification({ error });
      return null;
    }
  }
  return {
    file,
    uuid: uuidv4(),
    status: blockedFor
      ? ('blocked' as TrackedFile['status'])
      : ('uploading' as TrackedFile['status']),
    message: blockedFor?.filter(isDefined).join(', '),
    ...processed,
    ...processed.metadata,
    url: processed.objectUrl,
  };
};
