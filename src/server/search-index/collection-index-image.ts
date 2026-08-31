import { Prisma } from '@prisma/client';
import type { MediaType } from '~/shared/utils/prisma/enums';

/**
 * Every image field the collections index ships, and the only place that set is defined.
 *
 * Each entry exists because something renders or gates on it:
 *   id/url/name          EdgeMedia src, filename and alt text
 *   type                 picks the video still-frame request (`transcode`) in CollectionCard
 *   hash/width/height    MediaHash blurhash placeholder
 *   nsfwLevel/userId     ImageGuard2 blur + owner reveal
 *   poi/minor            ImageGuard2 and useApplyHiddenPreferences gating
 *   postId               ImageGuard2 context menu
 *
 * 🔴 Keep every field a SCALAR with a fixed name. Meilisearch flattens nested objects
 * into dotted field names and mints one field id per distinct name, index-wide — a u16
 * space of 65,536 that is never reclaimed, not a per-document budget. Shipping
 * `image.meta` wholesale minted a field id per LoRA anyone had ever used (its `hashes`
 * keys embed resource names), exhausted that map on collections_v3, and every write to
 * the index failed for eight weeks behind a per-document error message. A json column
 * here will do it again.
 */
export const COLLECTION_INDEX_IMAGE_FIELDS = [
  'id',
  'postId',
  'name',
  'url',
  'nsfwLevel',
  'width',
  'height',
  'hash',
  'type',
  'userId',
  'poi',
  'minor',
] as const;

export type CollectionIndexImage = {
  id: number;
  postId: number | null;
  name: string | null;
  url: string;
  nsfwLevel: number;
  width: number | null;
  height: number | null;
  hash: string | null;
  type: MediaType;
  userId: number;
  poi: boolean;
  minor: boolean;
};

/**
 * Projects an `Image` aliased as `i` into the shape above. Callers must alias the table
 * as `i`; the fragment is shared by the cover-image and item-image CTEs.
 */
export const collectionIndexImageSql = Prisma.sql`
    jsonb_build_object(
        'id', i."id",
        'postId', i."postId",
        'name', i."name",
        'url', i."url",
        'nsfwLevel', i."nsfwLevel",
        'width', i."width",
        'height', i."height",
        'hash', i."hash",
        'type', i."type",
        'userId', i."userId",
        'poi', i."poi",
        'minor', i."minor"
      ) image
  `;
