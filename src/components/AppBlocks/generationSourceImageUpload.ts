import { DIM_MAX, DIM_MIN } from '~/server/schema/blocks/workflow.schema';
import { imageToJpegBlob, resizeImage } from '~/shared/utils/canvas-utils';
import { uploadConsumerBlob } from '~/utils/consumer-blob-upload';
import { getImageDimensions } from '~/utils/image-utils';

/** Shown when the upload went through but the uploaded image then failed to load back. */
export const UPLOAD_UNCONFIRMED_ERROR = "Couldn't confirm the upload. Please try again.";

/**
 * An image as a private generation source, before upload: downscaled into the workflow
 * source-image bounds and re-encoded as JPEG, so a large photo still fits instead of being refused
 * at submit.
 */
export async function prepareGenerationSourceImage(file: Blob): Promise<Blob> {
  const resized = await resizeImage(file, {
    maxWidth: DIM_MAX,
    maxHeight: DIM_MAX,
    minWidth: DIM_MIN,
    minHeight: DIM_MIN,
  });
  return imageToJpegBlob(resized);
}

/** Width and height read back from an uploaded image, which also confirms it is there. */
export async function readBackUploadedImage(url: string) {
  return getImageDimensions(url, { loadRetries: 2 }).catch((e: unknown) => {
    throw new Error(UPLOAD_UNCONFIRMED_ERROR, { cause: e });
  });
}

/**
 * An image as a private generation source: prepared (`prepareGenerationSourceImage`), uploaded,
 * and its width and height read back from the uploaded blob, unless `isCurrent` says the caller
 * has moved on, when it resolves `null` without that read.
 */
export async function uploadGenerationSourceImage(
  file: Blob,
  isCurrent: () => boolean = () => true
) {
  const jpegBlob = await prepareGenerationSourceImage(file);
  const { url } = await uploadConsumerBlob(jpegBlob);
  if (!isCurrent()) return null;
  if (!url) throw new Error('Upload did not return a URL');
  const { width, height } = await readBackUploadedImage(url);
  return { url, width, height, sizeBytes: jpegBlob.size };
}
