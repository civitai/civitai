import exifr from 'exifr';
import { ImageMetaProps, imageMetaSchema } from '~/server/schema/image.schema';
import { automaticMetadataProcessor } from '~/utils/metadata/automatic.metadata';
import { comfyMetadataProcessor } from '~/utils/metadata/comfy.metadata';

const parsers = {
  automatic: automaticMetadataProcessor,
  comfy: comfyMetadataProcessor,
};

export async function getMetadata(file: File) {
  let exif: any; //eslint-disable-line
  try {
    exif = await exifr.parse(file, {
      userComment: true,
    });
    if (!exif) return {};
  } catch (e: any) { //eslint-disable-line
    return {};
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
