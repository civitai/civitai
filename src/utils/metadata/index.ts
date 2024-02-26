import ExifReader from 'exifreader';
import { v4 as uuidv4 } from 'uuid';
import { ImageMetaProps, imageMetaSchema } from '~/server/schema/image.schema';
import { automaticMetadataProcessor } from '~/utils/metadata/automatic.metadata';
import { comfyMetadataProcessor } from '~/utils/metadata/comfy.metadata';
import { isDefined } from '~/utils/type-guards';
import { auditImageMeta, preprocessFile } from '~/utils/media-preprocessors';
import { MediaType } from '@prisma/client';
import { showErrorNotification } from '~/utils/notifications';
import { calculateSizeInMegabytes } from '~/utils/json-helpers';
import { constants } from '~/server/common/constants';
import { rfooocusMetadataProcessor } from '~/utils/metadata/rfooocus.metadata';

const parsers = {
  automatic: automaticMetadataProcessor,
  comfy: comfyMetadataProcessor,
  rfooocus: rfooocusMetadataProcessor,
};

export async function getMetadata(file: File) {
  try {
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
  } catch (e) {
    return {};
  }
}

export function encodeMetadata(meta: ImageMetaProps, type: keyof typeof parsers = 'automatic') {
  return parsers[type]?.encode(meta);
}

export const parsePromptMetadata = (generationDetails: string) => {
  return automaticMetadataProcessor.parse({ generationDetails });
};

export type DataFromFile = AsyncReturnType<typeof getDataFromFile>;
export const getDataFromFile = async (file: File) => {
  const processed = await preprocessFile(file);
  const { blockedFor } = await auditImageMeta(
    processed.type === MediaType.image ? processed.meta : undefined,
    false
  );
  if (processed.type === 'video') {
    const { metadata } = processed;
    try {
      if (metadata.duration && metadata.duration > constants.mediaUpload.maxVideoDurationSeconds)
        throw new Error(
          `Video duration cannot be longer than ${constants.mediaUpload.maxVideoDurationSeconds} seconds. Please trim your video and try again.`
        );
      if (
        metadata.width > constants.mediaUpload.maxVideoDimension ||
        metadata.height > constants.mediaUpload.maxVideoDimension
      )
        throw new Error(
          `Images cannot be larger than ${constants.mediaUpload.maxVideoDimension}px from either side. Please resize your image and try again.`
        );
    } catch (error: any) {
      showErrorNotification({ error });
      return null;
    }
  }

  if (processed.type === 'image' && processed.meta.comfy) {
    const { comfy } = processed.meta;
    // if comfy metadata is larger than 1MB, we don't want to store it
    const tooLarge = calculateSizeInMegabytes(comfy) > 1;
    try {
      if (tooLarge)
        throw new Error('Comfy metadata is too large. Please consider updating your workflow');
    } catch (e) {
      const error = e as Error;
      showErrorNotification({ title: 'Unable to parse image metadata', error });
      return null;
    }
  }

  const { height, width, hash } = processed.metadata;

  return {
    file,
    uuid: uuidv4(),
    status: blockedFor
      ? ('blocked' as TrackedFile['status'])
      : ('uploading' as TrackedFile['status']),
    message: blockedFor?.filter(isDefined).join(', '),
    height,
    width,
    hash,
    ...processed,
    url: processed.objectUrl,
  };
};
