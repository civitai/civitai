import { copyMetadata } from '@civitai/generation-metadata';
import { fetchBlob, fetchBlobAsFile } from '~/utils/file-utils';
import { createImageElement, calculateAspectRatioFit } from '~/utils/image-utils';
import type { Area } from 'react-easy-crop';

/** A stage of preparing an image on the device before it is uploaded. */
export type ImagePrepStage =
  | 'pick-unreadable'
  | 'dims'
  | 'read-blob'
  | 'decode'
  | 'encode'
  | 'metadata'
  | 'dims-after-encode';

/**
 * A failure in one stage of preparing an image, tagged with the stage so a caller can report
 * where it failed. The message is the underlying error's, so what callers show is unchanged.
 */
export class ImagePrepError extends Error {
  constructor(
    readonly stage: ImagePrepStage,
    readonly timedOut: boolean,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ImagePrepError';
  }
}

/**
 * Runs one preparation stage. A failure becomes an ImagePrepError for that stage (an inner stage's
 * tag is kept), and with `timeoutMs` a stage that never settles fails as timed out instead of
 * hanging. The work itself cannot be cancelled; only the wait for it ends.
 */
export async function prepStage<T>(
  stage: ImagePrepStage,
  run: () => Promise<T>,
  timeoutMs?: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = run();
    if (!timeoutMs) return await work;
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ImagePrepError(stage, true, `${stage} timed out`)),
          timeoutMs
        );
      }),
    ]);
  } catch (e) {
    if (e instanceof ImagePrepError) throw e;
    throw new ImagePrepError(stage, false, e instanceof Error ? e.message : String(e), {
      cause: e,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function canvasToBlobWithImageExif(
  canvas: HTMLCanvasElement,
  src: File | Blob | string,
  timeoutMs?: number
) {
  const stripped = await prepStage(
    'encode',
    async () => {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg')
      );
      if (!blob) throw new Error('canvas.toBlob failed');
      return blob;
    },
    timeoutMs
  );
  const restored = await prepStage(
    'metadata',
    async () => copyMetadata(src, new Uint8Array(await stripped.arrayBuffer())),
    timeoutMs
  );
  return new Blob([restored as BlobPart], { type: 'image/jpeg' });
}

/** Opt-in bound, in ms, on each local stage that can hang (read, decode, encode, metadata). */
type PrepOptions = { stageTimeoutMs?: number };

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

export async function imageToJpegBlob(
  src: string | Blob | File,
  { stageTimeoutMs }: PrepOptions = {}
) {
  const blob = await prepStage(
    'read-blob',
    async () => {
      const blob = await fetchBlob(src);
      if (!blob) throw new Error('failed to load image blob');
      return blob;
    },
    stageTimeoutMs
  );

  if (blob.type === 'image/jpeg') return blob;

  const img = await prepStage('decode', () => createImageElement(blob), stageTimeoutMs);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImagePrepError('encode', false, 'Error resizing image');
  ctx.drawImage(img, 0, 0);

  return canvasToBlobWithImageExif(canvas, blob, stageTimeoutMs);
}

export async function resizeImage(
  src: string | Blob | File,
  options: {
    maxHeight?: number;
    maxWidth?: number;
    minWidth?: number;
    minHeight?: number;
  } & PrepOptions = {}
) {
  const { stageTimeoutMs } = options;
  const file = await prepStage(
    'read-blob',
    async () => {
      const file = await fetchBlobAsFile(src);
      if (!file) throw new Error('failed to load image blob');
      return file;
    },
    stageTimeoutMs
  );

  const img = await prepStage('decode', () => createImageElement(file), stageTimeoutMs);

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
  if (!ctx) throw new ImagePrepError('encode', false, 'Error resizing image');
  ctx.drawImage(img, 0, 0, width, height);

  return canvasToBlobWithImageExif(canvas, file, stageTimeoutMs);
}
