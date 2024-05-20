import { ImageMetaProps } from '~/server/schema/image.schema';
import { ImageMetadata } from '~/server/schema/media.schema';
import { createBlurHash } from '~/utils/blurhash';
import { getMetadata } from '~/utils/metadata';
import { auditMetaData } from '~/utils/metadata/audit';

export const loadImage = async (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (...args) => reject(args);
    img.src = src;
  });

const getImageData = async (url: string): Promise<ImageMetadata> => {
  const img = await loadImage(url);
  const width = img.width;
  const height = img.height;
  return {
    width,
    height,
    hash: createBlurHash(img, width, height),
  };
};

export const preprocessImage = async (file: File) => {
  const objectUrl = URL.createObjectURL(file);
  const metadata = await getImageData(objectUrl);
  const meta = await getMetadata(file);

  return {
    objectUrl,
    metadata: {
      size: file.size,
      ...metadata,
    },
    meta,
  };
};

export const auditImageMeta = async (meta: ImageMetaProps | undefined, nsfw: boolean) => {
  const auditResult = await auditMetaData(meta, nsfw);
  return { blockedFor: !auditResult?.success ? auditResult?.blockedFor : undefined };
};
