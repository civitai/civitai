// Page-local and NOT in `$lib/server/*`: the picker renders these, and a component importing a server
// module drags the service — and its database client — into the client bundle.
export const BULK_SOURCES = [
  'post',
  'model',
  'modelVersion',
  'collection',
  'user',
  'userRemoved',
  'imageIds',
] as const;
export type BulkSource = (typeof BULK_SOURCES)[number];

/**
 * `/api/mod/remove-images` takes a violation ENUM plus a details string and forwards both onto the
 * ClickHouse `DeleteTOS` event. Sending only free text left every removal from this page classified as
 * nothing. Mirrors `ViolationType` in the main app's `server/common/enums.ts`.
 */
export const VIOLATION_TYPES = [
  'realPerson',
  'realPersonNsfw',
  'realisticMinor',
  'realisticMinorNsfw',
  'animatedMinorNsfw',
  'schoolNsfw',
  'bestiality',
  'sexualViolence',
  'mindAlteredNsfw',
  'fecalMatter',
  'gore',
  'diaper',
  'anorexia',
  'bodilyFluids',
  'incest',
  'hate',
  'non-ai',
  'spam',
  'other',
] as const;

export const BULK_SOURCE_LABELS: Record<BulkSource, string> = {
  post: 'Post ID',
  model: 'Model ID',
  modelVersion: 'Model version ID',
  collection: 'Collection ID',
  user: 'User ID or username',
  userRemoved: 'User — already removed',
  imageIds: 'Image IDs (comma or newline)',
};
