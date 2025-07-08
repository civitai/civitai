import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { ImageMetadata } from '~/server/schema/media.schema';
import { createBlurHash } from '~/utils/blurhash';
import { createImageElement } from '~/utils/image-utils';
import { getMetadata } from '~/utils/metadata';
import { auditMetaData } from '~/utils/metadata/audit';

export const preprocessImage = async (file: File) => {
  const objectUrl = URL.createObjectURL(file);
  const img = await createImageElement(file);
  const meta = await getMetadata(file);

  if (file.type === 'image/webp' && (await isAnimatedWebP(file))) {
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

async function isAnimatedWebP(file: File) {
  const buffer = await file.slice(0, 4096).arrayBuffer(); // Read first few KB
  const bytes = new Uint8Array(buffer);

  // Look for 'ANIM' chunk in WebP file
  const str = new TextDecoder().decode(bytes);
  return str.includes('ANIM');
}
