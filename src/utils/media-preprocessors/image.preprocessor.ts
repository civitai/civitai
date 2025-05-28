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
