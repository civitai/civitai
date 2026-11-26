/**
 * Per-item fields the App Blocks collection DETAIL endpoint
 * (`/api/v1/blocks/collections/[id]`) adds to each media item. Dependency-free so the
 * rules are testable as functions of their inputs.
 */

export type CollectionItemExtraFields = {
  /**
   * When the item was added to the collection (`CollectionItem.createdAt`, NOT the
   * image's own upload time), as an ISO 8601 string. `null` when the row has none.
   */
  addedAt: string | null;
  /**
   * Video length in seconds, from the video's stored `metadata.duration`. Present ONLY
   * on a video item whose stored duration is a finite number greater than zero; the key
   * is omitted (never `null`, never `0`) for still images and for unknown lengths.
   */
  duration?: number;
};

/** `CollectionItem.createdAt` → ISO 8601, or `null` when absent or unparseable. */
export function toCollectionItemAddedAt(
  createdAt: Date | string | null | undefined
): string | null {
  if (createdAt == null) return null;
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * A video's length in seconds from its stored `metadata.duration`, or `undefined` when
 * the item is not a video or the stored value is not a finite number > 0. A string is
 * refused rather than coerced: the metadata schema types the field as a number.
 */
export function videoDurationSeconds(
  mediaType: 'image' | 'video',
  metadata: unknown
): number | undefined {
  if (mediaType !== 'video') return undefined;
  if (metadata == null || typeof metadata !== 'object') return undefined;
  const duration = (metadata as { duration?: unknown }).duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    return undefined;
  }
  return duration;
}

/**
 * The extra fields for one item, in wire order: `addedAt` always, then `duration` only
 * when known (the key is absent otherwise, so `'duration' in item` means a real length).
 */
export function collectionItemExtraFields({
  mediaType,
  metadata,
  addedAt,
}: {
  mediaType: 'image' | 'video';
  metadata: unknown;
  addedAt: Date | string | null | undefined;
}): CollectionItemExtraFields {
  const duration = videoDurationSeconds(mediaType, metadata);
  return {
    addedAt: toCollectionItemAddedAt(addedAt),
    ...(duration !== undefined ? { duration } : {}),
  };
}
