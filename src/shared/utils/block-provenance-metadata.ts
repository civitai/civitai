/**
 * `Image.metadata` keys that record which App Block app produced an image. They are
 * server-owned: only a server path that has verified the app passes one to `createImage`
 * (its `blockProvenance` argument), and every client-supplied copy is dropped. A new
 * provenance key must be added here together with its writer.
 */
export const BLOCK_PROVENANCE_METADATA_KEYS = ['blockPublishedAppId'] as const;

export type BlockProvenanceMetadataKey = (typeof BLOCK_PROVENANCE_METADATA_KEYS)[number];

export function isBlockProvenanceMetadataKey(key: string): boolean {
  return (BLOCK_PROVENANCE_METADATA_KEYS as readonly string[]).includes(key);
}

/** Returns `metadata` without any block provenance key; other keys are kept as-is. */
export function stripBlockProvenanceMetadata<T extends Record<string, unknown> | null | undefined>(
  metadata: T
): T {
  if (!metadata || typeof metadata !== 'object') return metadata;
  if (!Object.keys(metadata).some(isBlockProvenanceMetadataKey)) return metadata;
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !isBlockProvenanceMetadataKey(key))
  ) as T;
}
