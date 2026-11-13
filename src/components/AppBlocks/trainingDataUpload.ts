import { trainingBlobKeyFromAir } from '~/server/schema/blocks/training-dataset.schema';
import { uploadConsumerBlob } from '~/utils/consumer-blob-upload';

/** One uploaded training image: the blob url, and the key a `kind:'training'` item names. */
export type TrainingDataUpload = { url: string; air: string };

/**
 * Upload one image as a consumer blob, as the Training Studio does: the original
 * file, no resize. Throws when the orchestrator returned no usable blob.
 */
export async function uploadTrainingDataImage(file: Blob): Promise<TrainingDataUpload> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose image files.');
  const blob = await uploadConsumerBlob(file);
  if (!blob.url || blob.blockedReason) throw new Error('This image could not be uploaded.');
  const air = trainingBlobKeyFromAir(blob.url);
  if (!air) throw new Error('This image could not be uploaded.');
  return { url: blob.url, air };
}
