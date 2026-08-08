// The five things a batch can be found by. Page-local and NOT in `$lib/server/*`: the picker renders
// these, and a component importing a server module drags the service — and its database client — at
// the client bundle.
export const BULK_SOURCES = ['post', 'model', 'modelVersion', 'collection', 'user'] as const;
export type BulkSource = (typeof BULK_SOURCES)[number];

export const BULK_SOURCE_LABELS: Record<BulkSource, string> = {
  post: 'Post ID',
  model: 'Model ID',
  modelVersion: 'Model version ID',
  collection: 'Collection ID',
  user: 'User ID or username',
};
