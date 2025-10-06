import { NsfwLevel } from '~/server/common/enums';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { TagType } from '~/shared/utils/prisma/enums';

import {
  isNsfwLevelRestrictedForBaseModel,
  getRestrictedNsfwLevelsForBaseModel,
  maxUpscaleSize,
} from '~/server/common/constants';
import type { ImageResourceHelper } from '~/shared/utils/prisma/models';

export function hasImageLicenseViolation(image: {
  nsfwLevel: number;
  resourceHelper: ImageResourceHelper[];
}) {
  const { nsfwLevel, resourceHelper } = image;

  const restrictedResources = resourceHelper.filter((resource) => {
    if (!resource.modelVersionBaseModel) return false;
    return isNsfwLevelRestrictedForBaseModel(resource.modelVersionBaseModel, nsfwLevel);
  });

  if (restrictedResources.length > 0) {
    return {
      violation: true,
      nsfwLevel,
      restrictedResources: restrictedResources.map((r) => ({
        modelName: r.modelName,
        baseModel: r.modelVersionBaseModel,
        restrictedLevels: getRestrictedNsfwLevelsForBaseModel(r.modelVersionBaseModel || ''),
      })),
    };
  }

  return { violation: false };
}

// deprecated?
export async function imageToBlurhash(url: string) {
  // if (typeof url === 'string')
  //   url = arrayBufferToBuffer(await fetch(url).then((r) => r.arrayBuffer()));

  // const image = await sharp(url);
  // const { width, height } = await image.metadata();
  // if (width === undefined || height === undefined) throw new Error('Image has no metadata');

  // const { width: cw, height: ch } = getClampedSize(width, height, 64);
  // const shrunkImage = await image.raw().ensureAlpha().resize(cw, ch, { fit: 'inside' }).toBuffer();
  // const hash = encode(new Uint8ClampedArray(shrunkImage), cw, ch, 4, 4);
  return { hash: '', width: 0, height: 0 };
}

export async function createImageElement(src: string | Blob | File) {
  const objectUrl = typeof src === 'string' ? src : URL.createObjectURL(src);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.addEventListener('load', () => resolve(img));
    img.addEventListener('error', (error) => reject(error));
    img.src = objectUrl;
  });
}

export async function getImageDimensions(src: string | Blob | File) {
  const img = await createImageElement(src);
  return {
    width: img.width,
    height: img.height,
  };
}

/**
 * Conserve aspect ratio of the original region. Useful when shrinking/enlarging
 * images to fit into a certain area.
 *
 * @param {Number} srcWidth width of source image
 * @param {Number} srcHeight height of source image
 * @param {Number} maxWidth maximum available width
 * @param {Number} maxHeight maximum available height
 * @return {Object} { width, height }
 */
export function calculateAspectRatioFit(
  srcWidth: number,
  srcHeight: number,
  maxWidth: number,
  maxHeight: number
) {
  if (srcWidth > maxWidth || srcHeight > maxHeight) {
    const ratio = Math.min(maxWidth / srcWidth, maxHeight / srcHeight);

    return { width: srcWidth * ratio, height: srcHeight * ratio, mutated: true };
  } else {
    return { width: srcWidth, height: srcHeight, mutated: false };
  }
}

type ImageForAiVerification = {
  id: number;
  nsfwLevel: number;
  meta?: ImageMetaProps | null;
  tools?: any[] | null;
  resources?: any[] | null;
  tags?:
    | {
        nsfwLevel: number;
        type: TagType;
      }[]
    | null;
};

/**
 * Check if the image is a valid AI generation. Currently, the only way we can tell this is by checking metadata values & tools.
 *
 * @param image Image object with meta and tools properties.
 * @returns
 */

export function isValidAiMeta(meta?: Record<string, any> | null) {
  if (meta?.prompt) return true;
  if (meta?.civitaiResources) return true;
  return false;
}

export function isValidAIGeneration(image: ImageForAiVerification) {
  if (isValidAiMeta(image.meta)) return true;
  // Updated to only allow prompt.
  // if (image.meta?.comfy) return true;
  // if (image.meta?.extra) return true;
  // if (image.tools?.length) return true;
  // if (image.resources?.length) return true;

  // PG images are alright for us anyway.
  if (image.nsfwLevel !== 0 && image.nsfwLevel <= NsfwLevel.R) return true;

  if (image.nsfwLevel > NsfwLevel.R) {
    // We need some of the above.
    return false;
  }

  // If NSFW level is 0 or something else, we can go ahead and check tags:.
  const hasNsfwTag = image.tags?.some((tag) => {
    return tag.nsfwLevel > NsfwLevel.R && tag.type === TagType.Moderation;
  });

  return !hasNsfwTag;
}

export function getRoundedWidthHeight({ width, height }: { width: number; height: number }) {
  const maxWidth = width < maxUpscaleSize ? width : maxUpscaleSize;
  const maxHeight = height < maxUpscaleSize ? height : maxUpscaleSize;
  const ratio = Math.min(maxWidth / width, maxHeight / height);
  return {
    width: Math.ceil((width * ratio) / 64) * 64,
    height: Math.ceil((height * ratio) / 64) * 64,
  };
}

export async function getSourceImageFromUrl({ url, upscale }: { url: string; upscale?: boolean }) {
  return getImageDimensions(url).then(({ width, height }) => {
    let upscaleWidth: number | undefined;
    let upscaleHeight: number | undefined;
    if (upscale) {
      const upscaled = getRoundedWidthHeight({ width: width * 1.5, height: height * 1.5 });
      upscaleWidth = upscaled.width;
      upscaleHeight = upscaled.height;
    }
    return { url, upscaleWidth, upscaleHeight, ...getRoundedWidthHeight({ width, height }) };
  });
}
