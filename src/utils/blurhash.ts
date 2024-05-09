import { encode } from 'blurhash';

export type HashResult = {
  hash: string;
  width: number;
  height: number;
};

// export const getImageData = async (img: HTMLImageElement) => {
//   const canvas = document.createElement('canvas');
//   const { height: h, width: w } = img;
//   canvas.height = h;
//   canvas.width = w;
//   const ctx = canvas.getContext('2d');
//   if (!ctx) throw new Error('unable to get canvas context');
//   ctx.drawImage(img, 0, 0);
//   const canvasData = ctx.getImageData(0, 0, w, h).data;
//   const imageData = new ImageData(canvasData, w, h);
//   return imageData;
// };

export const getClampedSize = (
  width: number,
  height: number,
  max: number,
  type: 'width' | 'height' | 'all' = 'all'
): { width: number; height: number } => {
  if (type === 'all') {
    if (width >= height) type = 'width';
    else if (height >= width) type = 'height';
  }

  if (type === 'width' && width > max)
    return { width: max, height: Math.round((height / width) * max) };

  if (type === 'height' && height > max)
    return { width: Math.round((width / height) * max), height: max };

  return { width, height };
};

// export const getClampedSize = (
//   width: number,
//   height: number,
//   max: number
// ): { width: number; height: number } => {
//   if (width >= height && width > max) {
//     return { width: max, height: Math.round((height / width) * max) };
//   }

//   if (height > width && height > max) {
//     return { width: Math.round((width / height) * max), height: max };
//   }

//   return { width, height };
// };

export function blurHashImage(img: HTMLImageElement): HashResult {
  const clampedSize = getClampedSize(img.width, img.height, 64);
  const canvas = document.createElement('canvas');
  canvas.width = clampedSize.width;
  canvas.height = clampedSize.height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.drawImage(img, 0, 0, clampedSize.width, clampedSize.height);

  const { data, width, height } = ctx.getImageData(0, 0, clampedSize.width, clampedSize.height);
  const hash = encode(data, width, height, 4, 4);
  return { hash, width: img.width, height: img.height };
}

export function createBlurHash(
  media: HTMLImageElement | HTMLVideoElement,
  width: number,
  height: number
) {
  const clampedSize = getClampedSize(width, height, 64);
  const canvas = document.createElement('canvas');
  canvas.width = clampedSize.width;
  canvas.height = clampedSize.height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.drawImage(media, 0, 0, clampedSize.width, clampedSize.height);
  const result = ctx.getImageData(0, 0, clampedSize.width, clampedSize.height);
  return encode(result.data, result.width, result.height, 4, 4);
}
