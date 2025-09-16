import { blobToFile, fetchBlob, fetchBlobAsFile } from '~/utils/file-utils';
import { encodeMetadata, ExifParser } from '~/utils/metadata';
import {
  createExifSegmentFromTags,
  encodeUserCommentUTF16BE,
  isEncoded,
} from '~/utils/encoding-helpers';
import { createImageElement, calculateAspectRatioFit } from '~/utils/image-utils';
import type { Area } from 'react-easy-crop';

async function canvasToBlobWithImageExif(canvas: HTMLCanvasElement, src: File | Blob | string) {
  const image = src instanceof File || typeof src === 'string' ? src : blobToFile(src);
  const parser = await ExifParser(image);
  let userComment =
    parser.exif.userComment && isEncoded(parser.exif.userComment)
      ? parser.exif.userComment
      : undefined;
  if (!userComment) {
    const meta = await parser.getMetadata();
    if (Object.keys(meta).length > 0) {
      userComment = encodeUserCommentUTF16BE(encodeMetadata(meta));
    }
  }
  const dataUrl = canvas.toDataURL('image/jpeg');

  const exifSegment = createExifSegmentFromTags({
    artist: parser.exif.Artist,
    userComment,
    software: parser.exif.Software,
  });
  const jpegBytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  const soi = Uint8Array.prototype.slice.call(jpegBytes, 0, 2); // FFD8
  const rest = Uint8Array.prototype.slice.call(jpegBytes, 2);
  const newJpegBytes = new Uint8Array(soi.length + exifSegment.length + rest.length);

  newJpegBytes.set(soi, 0);
  newJpegBytes.set(exifSegment, soi.length);
  newJpegBytes.set(rest, soi.length + exifSegment.length);

  return new Blob([newJpegBytes], { type: 'image/jpeg' });
}

export function getRadianAngle(degreeValue: number) {
  return (degreeValue * Math.PI) / 180;
}

/**
 * Returns the new bounding area of a rotated rectangle.
 */
export function rotateSize(width: number, height: number, rotation: number) {
  const rotRad = getRadianAngle(rotation);

  return {
    width: Math.abs(Math.cos(rotRad) * width) + Math.abs(Math.sin(rotRad) * height),
    height: Math.abs(Math.sin(rotRad) * width) + Math.abs(Math.cos(rotRad) * height),
  };
}

/**
 * This function was adapted from the one in the ReadMe of https://github.com/DominicTobias/react-image-crop
 */
export async function getCroppedImg(
  imageSrc: string,
  pixelCrop: Area,
  rotation = 0,
  flip = { horizontal: false, vertical: false }
) {
  const image = await createImageElement(imageSrc);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  if (!ctx) return;

  const rotRad = getRadianAngle(rotation);

  // calculate bounding box of the rotated image
  const { width: bBoxWidth, height: bBoxHeight } = rotateSize(image.width, image.height, rotation);

  // set canvas size to match the bounding box
  canvas.width = bBoxWidth;
  canvas.height = bBoxHeight;

  // translate canvas context to a central location to allow rotating and flipping around the center
  ctx.translate(bBoxWidth / 2, bBoxHeight / 2);
  ctx.rotate(rotRad);
  ctx.scale(flip.horizontal ? -1 : 1, flip.vertical ? -1 : 1);
  ctx.translate(-image.width / 2, -image.height / 2);

  // draw rotated image
  ctx.drawImage(image, 0, 0);

  const croppedCanvas = document.createElement('canvas');

  const croppedCtx = croppedCanvas.getContext('2d');

  if (!croppedCtx) return;

  // Set the size of the cropped canvas
  croppedCanvas.width = pixelCrop.width;
  croppedCanvas.height = pixelCrop.height;

  // Draw the cropped image onto the new canvas
  croppedCtx.drawImage(
    canvas,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    pixelCrop.width,
    pixelCrop.height
  );

  const file = await fetchBlobAsFile(imageSrc);
  if (!file) return;

  const blob = await canvasToBlobWithImageExif(croppedCanvas, file);
  return blob;
}

export async function imageToJpegBlob(src: string | Blob | File) {
  const blob = await fetchBlob(src);
  if (!blob) throw new Error('failed to load image blob');

  if (blob.type === 'image/jpeg') return blob;

  const img = await createImageElement(blob);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Error resizing image');
  ctx.drawImage(img, 0, 0);

  return canvasToBlobWithImageExif(canvas, blob);
}

export async function resizeImage(
  src: string | Blob | File,
  options: {
    maxHeight?: number;
    maxWidth?: number;
    minWidth?: number;
    minHeight?: number;
  } = {}
) {
  const file = await fetchBlobAsFile(src);
  if (!file) throw new Error('failed to load image blob');

  // const url = URL.createObjectURL(blob);
  const img = await createImageElement(file);

  const { maxWidth = img.width, maxHeight = img.height, minWidth, minHeight } = options;

  if (minWidth && img.width < minWidth)
    throw new Error(`Does not meet minimum width requirement: ${minWidth}px`);
  if (minHeight && img.height < minHeight)
    throw new Error(`Does not meet minimum height requirement: ${minHeight}px`);

  const { width, height, mutated } = calculateAspectRatioFit(
    img.width,
    img.height,
    maxWidth,
    maxHeight
  );
  if (!mutated) return file;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Error resizing image');
  ctx.drawImage(img, 0, 0, width, height);

  return canvasToBlobWithImageExif(canvas, file);
}
