import { flagifyBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import type { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';

function handleOldImageTags(tags?: number[] | { id: number }[]) {
  if (!tags) return [];
  return tags.map((tag) => (typeof tag === 'number' ? tag : tag?.id));
}

// Shared shaping of raw models-index documents into the card-ready record the
// ResourceSelectModal / search grids consume. Used client-side (over
// react-instantsearch `Hit`s) AND server-side (over the tRPC picker endpoint).
// Generic over the element type so the client keeps its `Hit` metadata while the
// server returns plain records — both yield the same overridden fields.
export function transformModelHits<T extends ModelSearchIndexRecord>(items: T[]) {
  return items.map((item) => ({
    ...item,
    nsfwLevel: flagifyBrowsingLevel(item.nsfwLevel),
    // Meilisearch returns these as ISO strings while the DB path yields real
    // Dates; normalize so date math (the New/Updated badges) works on both. The
    // type already claims Date, and `new Date(date)` just clones an existing Date.
    publishedAt: item.publishedAt ? new Date(item.publishedAt) : item.publishedAt,
    lastVersionAt: item.lastVersionAt ? new Date(item.lastVersionAt) : item.lastVersionAt,
    tags: item.tags.map((t) => t.id),
    images:
      item.images?.map((image) => ({
        ...image,
        tags: handleOldImageTags(image.tags),
      })) ?? [],
  }));
}

// The card-ready record shape (the transform over a plain index record, without
// any client-only instantsearch `Hit` metadata) — this is exactly what the
// getResourceSelect tRPC endpoint returns per item.
export type TransformedModel = ReturnType<typeof transformModelHits>[number];
