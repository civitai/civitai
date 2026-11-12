import { FEEDBACK_CAPTURE_METADATA_KEY } from '@civitai/shared/feedback-capture';

/**
 * `Image.metadata` keys that record which App Block app produced an image. They are
 * server-owned: only a server path that has verified the app passes one to `createImage`
 * (its `blockProvenance` argument), and every client-supplied copy is dropped. A new
 * provenance key must be added here together with its writer.
 *
 *  - `blockPublishedAppId`: a workflow output the app published (`persistBlockWorkflowOutputImage`).
 *  - `blockUploadedAppId`: an image the app uploaded from bytes (`persistBlockUploadImage`).
 */
export const BLOCK_PROVENANCE_METADATA_KEYS = [
  'blockPublishedAppId',
  'blockUploadedAppId',
] as const;

export type BlockProvenanceMetadataKey = (typeof BLOCK_PROVENANCE_METADATA_KEYS)[number];

export function isBlockProvenanceMetadataKey(key: string): boolean {
  return (BLOCK_PROVENANCE_METADATA_KEYS as readonly string[]).includes(key);
}

/** A judge's rating in a judge-rated collection (`setCollectionItemNsfwLevel`); it gates approval. */
export const JUDGE_RATING_METADATA_KEY = 'judgeRating';

/**
 * Other server-owned `Image.metadata` keys, dropped from client input the same way:
 *  - `feedbackCapture`: the report a page capture belongs to (`createImage`'s `feedbackCapture`).
 *  - `judgeRating`: see `JUDGE_RATING_METADATA_KEY`.
 */
export const OTHER_SERVER_OWNED_IMAGE_METADATA_KEYS = [
  FEEDBACK_CAPTURE_METADATA_KEY,
  JUDGE_RATING_METADATA_KEY,
] as const;

const isServerOwnedMetadataKey = (key: string) =>
  isBlockProvenanceMetadataKey(key) ||
  (OTHER_SERVER_OWNED_IMAGE_METADATA_KEYS as readonly string[]).includes(key);

/** Returns `metadata` without any server-owned key; other keys are kept as-is. */
export function stripBlockProvenanceMetadata<T extends Record<string, unknown> | null | undefined>(
  metadata: T
): T {
  if (!metadata || typeof metadata !== 'object') return metadata;
  if (!Object.keys(metadata).some(isServerOwnedMetadataKey)) return metadata;
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !isServerOwnedMetadataKey(key))
  ) as T;
}
