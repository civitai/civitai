import exifr from 'exifr';
import { v4 as uuidv4 } from 'uuid';
import { ImageMetaProps, imageMetaSchema } from '~/server/schema/image.schema';
import { loadImage, blurHashImage } from '~/utils/blurhash';
import { automaticMetadataProcessor } from '~/utils/metadata/automatic.metadata';
import { comfyMetadataProcessor } from '~/utils/metadata/comfy.metadata';
import { auditMetaData } from '~/utils/metadata/audit';
import { isDefined } from '~/utils/type-guards';

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

export const getImageDataFromFile = async (file: File) => {
  const url = URL.createObjectURL(file);
  const meta = await getMetadata(file);
  const img = await loadImage(url);
  const hashResult = blurHashImage(img);
  const auditResult = await auditMetaData(meta, false);
  const mimeType = file.type;
  const blockedFor = !auditResult?.success ? auditResult?.blockedFor : undefined;

  return {
    file,
    uuid: uuidv4(),
    name: file.name,
    meta,
    url,
    mimeType,
    ...hashResult,
    status: blockedFor
      ? ('blocked' as TrackedFile['status'])
      : ('uploading' as TrackedFile['status']),
    message: blockedFor?.filter(isDefined).join(', '),
  };
};
