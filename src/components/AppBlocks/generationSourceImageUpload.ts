import { DIM_MAX, DIM_MIN } from '~/server/schema/blocks/workflow.schema';
import { imageToJpegBlob, resizeImage } from '~/shared/utils/canvas-utils';
import { uploadConsumerBlob } from '~/utils/consumer-blob-upload';
import { getImageDimensions } from '~/utils/image-utils';

/** Shown when the upload went through but the uploaded image then failed to load back. */
export const UPLOAD_UNCONFIRMED_ERROR = "Couldn't confirm the upload. Please try again.";

/**
 * An image as a private generation source: downscaled into the workflow source-image bounds and
 * re-encoded as JPEG BEFORE upload, so a large photo still fits instead of being refused at
 * submit. Width and height are read back from the uploaded blob, unless `isCurrent` says the
 * caller has moved on, when it resolves `null` without that read.
 */
export async function uploadGenerationSourceImage(
  file: Blob,
  isCurrent: () => boolean = () => true
) {
  const resized = await resizeImage(file, {
    maxWidth: DIM_MAX,
    maxHeight: DIM_MAX,
    minWidth: DIM_MIN,
    minHeight: DIM_MIN,
  });
  const jpegBlob = await imageToJpegBlob(resized);
  const { url } = await uploadConsumerBlob(jpegBlob);
  if (!isCurrent()) return null;
  if (!url) throw new Error('Upload did not return a URL');
  const { width, height } = await getImageDimensions(url, { loadRetries: 2 }).catch(
    (e: unknown) => {
      throw new Error(UPLOAD_UNCONFIRMED_ERROR, { cause: e });
    }
  );
  return { url, width, height, sizeBytes: jpegBlob.size };
}
