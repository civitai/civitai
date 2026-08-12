/**
 * Markers identifying a CollectionItem the auto-feature job added, rather than a curator.
 *
 * Their own module because both the job and the collection-item removal path need them, and
 * importing the service from collection.service.ts would pull the whole home-block graph in.
 */
export const AUTO_FEATURE_USER_ID = 12042163;
export const AUTO_FEATURE_NOTE_PREFIX = 'auto-featured';
export const autoFeatureNote = (sourceCollectionId: number) =>
  `${AUTO_FEATURE_NOTE_PREFIX}:${sourceCollectionId}`;
