import { encode } from 'blurhash';

export type HashResult = {
  hash: string;
  width: number;
  height: number;
};

export const getClampedSize = (
  width: number,
  height: number,
  max: number
): { width: number; height: number } => {
  if (width >= height && width > max) {
    return { width: max, height: Math.round((height / width) * max) };
  }

  if (height > width && height > max) {
    return { width: Math.round((width / height) * max), height: max };
  }

  return { width, height };
};

export function blurHashImage(img: HTMLImageElement): HashResult {
  const clampedSize = getClampedSize(img.naturalWidth, img.naturalHeight, 64);
  const canvas = document.createElement('canvas');
  canvas.width = clampedSize.width;
  canvas.height = clampedSize.height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.drawImage(img, 0, 0, clampedSize.width, clampedSize.height);

  const { data, width, height } = ctx.getImageData(0, 0, clampedSize.width, clampedSize.height);
  const hash = encode(data, width, height, 4, 4);
  return { hash, width: img.naturalWidth, height: img.naturalHeight };
}
