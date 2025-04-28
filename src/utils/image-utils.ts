// import sharp from 'sharp';
import { encode } from 'blurhash';
import arrayBufferToBuffer from 'arraybuffer-to-buffer';

import { fetchBlob } from '~/utils/file-utils';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { NSFWLevel } from '@civitai/client';
import { NsfwLevel } from '~/server/common/enums';
import { TagType } from '~/shared/utils/prisma/enums';

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
    const image = new Image();
    image.addEventListener('load', () => {
      resolve(image);
      // URL.revokeObjectURL(objectUrl)
    });
    image.addEventListener('error', (error) => reject(error));
    image.src = objectUrl;
  });
}

export async function resizeImage(
  src: string | Blob | File,
  options: {
    maxHeight?: number;
    maxWidth?: number;
    onResize?: (args: { width: number; height: number }) => void;
  } = {}
) {
  const blob = await fetchBlob(src);
  if (!blob) throw new Error('failed to load image blob');

  // const url = URL.createObjectURL(blob);
  const img = await createImageElement(blob);

  const { maxWidth = img.width, maxHeight = img.height, onResize } = options;

  const { width, height, mutated } = calculateAspectRatioFit(
    img.width,
    img.height,
    maxWidth,
    maxHeight
  );
  if (!mutated) return blob;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Error resizing image');
  ctx.drawImage(img, 0, 0, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((file) => {
      if (!file) reject();
      else {
        onResize?.({ width, height });
        resolve(file);
      }
    }, blob.type);
  });
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

export function isValidAIGeneration(image: ImageForAiVerification) {
  if (image.meta?.prompt) return true;
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
