import { describe, expect, it } from 'vitest';
import {
  COLLECTION_INDEX_IMAGE_FIELDS,
  collectionIndexImageSql,
} from '~/server/search-index/collection-index-image';

/**
 * Meilisearch assigns every distinct flattened field name a permanent, index-wide field
 * id out of a u16 space (65,536) that is never reclaimed. Shipping `image.meta` — whose
 * `hashes` keys embed user-supplied resource names — exhausted that space on
 * collections_v3 and broke every write to the index for eight weeks. These tests pin the
 * projection to a fixed set of scalars so that cannot recur, and cover the fields the
 * card needs to render.
 */

/** Keys the SQL fragment projects, e.g. `'id', i."id"` -> `id`. */
const projectedKeys = () => {
  const sql = collectionIndexImageSql.sql;
  return [...sql.matchAll(/'([A-Za-z]+)',\s*i\."/g)].map((m) => m[1]);
};

describe('collectionIndexImageSql', () => {
  it('projects exactly the declared field set, in the same order', () => {
    expect(projectedKeys()).toEqual([...COLLECTION_INDEX_IMAGE_FIELDS]);
  });

  it('projects no json column', () => {
    // `meta` is the one that broke the index; any json column has the same failure mode.
    expect(collectionIndexImageSql.sql).not.toMatch(/i\."meta"/);
    expect(projectedKeys()).not.toContain('meta');
  });

  it('carries the fields CollectionCard renders and gates on', () => {
    const fields = new Set<string>(COLLECTION_INDEX_IMAGE_FIELDS);

    // EdgeMedia src/name, and `type` selects the video still-frame request. Without
    // `type` a video cover would be requested as an animated image rather than a poster.
    for (const field of ['url', 'name', 'type']) expect(fields).toContain(field);
    // MediaHash blurhash placeholder while the image is gated or loading.
    for (const field of ['hash', 'width', 'height']) expect(fields).toContain(field);
    // ImageGuard2 + useApplyHiddenPreferences.
    for (const field of ['id', 'nsfwLevel', 'userId', 'poi', 'minor']) {
      expect(fields).toContain(field);
    }
  });

  it('binds no parameters, so it is safe to inline in every CTE', () => {
    expect(collectionIndexImageSql.values).toEqual([]);
  });
});
