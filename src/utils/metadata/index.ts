import ExifReader from 'exifreader';
import { v4 as uuidv4 } from 'uuid';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { imageMetaSchema } from '~/server/schema/image.schema';
import { automaticMetadataProcessor } from '~/utils/metadata/automatic.metadata';
import { comfyMetadataProcessor } from '~/utils/metadata/comfy.metadata';
import { isDefined } from '~/utils/type-guards';
import { auditImageMeta, preprocessFile } from '~/utils/media-preprocessors';
import { MediaType } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { calculateSizeInMegabytes } from '~/utils/json-helpers';
import { constants } from '~/server/common/constants';
import { rfooocusMetadataProcessor } from '~/utils/metadata/rfooocus.metadata';
import { setGlobalValue } from '~/utils/metadata/base.metadata';
import { swarmUIMetadataProcessor } from '~/utils/metadata/swarmui.metadata';

const parsers = {
  automatic: automaticMetadataProcessor,
  swarmui: swarmUIMetadataProcessor,
  rfooocus: rfooocusMetadataProcessor,
  comfy: comfyMetadataProcessor,
};

export async function ExifParser(file: File | string) {
  let tags: ExifReader.Tags = {};
  try {
    tags = await ExifReader.load(file, { includeUnknown: true });
  } catch (e) {
    console.error('failed to read exif data');
  }

  const exif = Object.entries(tags).reduce((acc, [key, value]) => {
    acc[key] = value.value;
    return acc;
  }, {} as Record<string, any>); //eslint-disable-line

  if (exif.UserComment) {
    // @ts-ignore - this is a hack to not have to rework our downstream code
    exif.userComment = Int32Array.from(exif.UserComment);
  }

  const [name, parser] = Object.entries(parsers).find(([name, x]) => x.canParse(exif)) ?? [];

  function parse() {
    try {
      return parser?.parse(exif);
    } catch (e) {
      console.error('Error parsing metadata', e);
    }
  }

  function encode(meta: ImageMetaProps) {
    try {
      return parser?.encode(meta) ?? '';
    } catch (e) {
      console.error('Error encoding metadata', e);
      return '';
    }
  }

  function isMadeOnSite() {
    if (!exif.Artist) return false;
    const artist = Array.isArray(exif.Artist) ? exif.Artist.join(', ') : exif.Artist;
    return artist === 'ai';
  }

  async function getMetadata() {
    try {
      const metadata = parse();
      const result = imageMetaSchema.safeParse(metadata ?? {});
      return result.success ? result.data : {};
    } catch (e) {
      console.error(e);
      return {};
    }
  }

  return { exif, parse, encode, getMetadata, isMadeOnSite };
}

export async function getMetadata(file: File | string) {
  const parser = await ExifParser(file);
  return parser.getMetadata();
}

export function encodeMetadata(meta: ImageMetaProps, type: keyof typeof parsers = 'automatic') {
  return parsers[type]?.encode(meta);
}

export const parsePromptMetadata = (generationDetails: string) => {
  return automaticMetadataProcessor.parse({ generationDetails });
};
