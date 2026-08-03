import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { ImageMetadata } from '~/server/schema/media.schema';
import { createBlurHash } from '~/utils/blurhash';
import { createImageElement } from '~/utils/image-utils';
import { getMetadata } from '~/utils/metadata';
import { auditMetaData } from '~/utils/metadata/audit';

export const preprocessImage = async (file: File, options?: { allowAnimatedWebP?: boolean }) => {
  const objectUrl = URL.createObjectURL(file);
  const img = await createImageElement(file);
  const meta = await getMetadata(file);

  if (!options?.allowAnimatedWebP && file.type === 'image/webp' && (await isAnimatedWebP(file))) {
    throw new Error(
      'Animated WebP files are not supported. Please upload animated images as videos.'
    );
  }

  return {
    objectUrl,
    metadata: {
      size: file.size,
      width: img.width,
      height: img.height,
      hash: createBlurHash(img, img.width, img.height),
    } as ImageMetadata,
    meta,
  };
};

export const auditImageMeta = async (meta: ImageMetaProps | undefined, nsfw: boolean) => {
  const auditResult = await auditMetaData(meta, nsfw);
  return { blockedFor: !auditResult?.success ? auditResult?.blockedFor : undefined };
};

// latin1 so binary bytes map 1:1 and the ASCII chunk fourcc survives intact.
async function scanHeader(file: File, marker: string) {
  const buffer = await file.slice(0, 4096).arrayBuffer();
  const str = new TextDecoder('latin1').decode(new Uint8Array(buffer));
  return str.includes(marker);
}

async function isAnimatedWebP(file: File) {
  return scanHeader(file, 'ANIM');
}

// APNG advertises itself with an 'acTL' chunk that precedes the first frame.
async function isAnimatedPng(file: File) {
  return scanHeader(file, 'acTL');
}

export async function isAnimatedImage(file: File) {
  if (file.type === 'image/webp') return isAnimatedWebP(file);
  if (file.type === 'image/png' || file.type === 'image/apng') return isAnimatedPng(file);
  return false;
}
