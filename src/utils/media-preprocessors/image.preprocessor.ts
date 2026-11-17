import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { ImageMetadata } from '~/server/schema/media.schema';
import { createBlurHash } from '~/utils/blurhash';
import { createImageElement } from '~/utils/image-utils';
import { getMetadata } from '~/utils/metadata';
import { auditPostImageMeta } from '~/utils/metadata/audit';

export const preprocessImage = async (file: File, options?: { allowAnimatedWebP?: boolean }) => {
  const img = await createImageElement(file);
  const meta = await getMetadata(file);

  if (!options?.allowAnimatedWebP && file.type === 'image/webp' && (await isAnimatedWebP(file))) {
    throw new Error(
      'Animated WebP files are not supported. Please upload animated images as videos.'
    );
  }
  if (file.type === 'image/avif' && (await isAnimatedAvif(file))) {
    throw new Error(
      'Animated AVIF files are not supported. Please upload animated images as videos.'
    );
  }

  // Made once every read has succeeded, so a file that fails leaves no url holding its bytes.
  return {
    objectUrl: URL.createObjectURL(file),
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
  const auditResult = auditPostImageMeta(meta, nsfw);
  return { blockedFor: !auditResult?.success ? auditResult?.blockedFor : undefined };
};

const fourcc = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));

// Read the VP8X header's animation flag rather than look for the ANIM chunk: an ICC profile comes
// before that chunk and can push it arbitrarily far into the file.
async function isAnimatedWebP(file: File) {
  const header = new Uint8Array(await file.slice(0, 21).arrayBuffer());
  return header.length === 21 && fourcc(header, 12) === 'VP8X' && (header[20] & 0x02) !== 0;
}

// APNG declares 'acTL' before the first IDAT, possibly after chunks of any size, so walk them.
async function isAnimatedPng(file: File) {
  const PNG_SIGNATURE_LENGTH = 8;
  let offset = PNG_SIGNATURE_LENGTH;
  while (offset + 8 <= file.size) {
    const chunk = new Uint8Array(await file.slice(offset, offset + 8).arrayBuffer());
    const type = fourcc(chunk, 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    // Length field + type + payload + CRC.
    offset += new DataView(chunk.buffer).getUint32(0) + 12;
  }
  return false;
}

// An image sequence declares the 'avis' brand in its leading ftyp box; a still image does not.
export async function isAnimatedAvif(file: Blob) {
  const view = new DataView(await file.slice(0, 256).arrayBuffer());
  if (view.byteLength < 16) return false;
  const fourcc = (offset: number) =>
    String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, 4));
  if (fourcc(4) !== 'ftyp') return false;
  const end = Math.min(view.getUint32(0), view.byteLength);
  // Major brand at 8, minor version at 12, compatible brands from 16.
  for (let offset = 8; offset + 4 <= end; offset += offset === 8 ? 8 : 4) {
    if (fourcc(offset) === 'avis') return true;
  }
  return false;
}

export async function isAnimatedImage(file: File) {
  if (file.type === 'image/webp') return isAnimatedWebP(file);
  if (file.type === 'image/avif') return isAnimatedAvif(file);
  if (file.type === 'image/png' || file.type === 'image/apng') return isAnimatedPng(file);
  return false;
}
