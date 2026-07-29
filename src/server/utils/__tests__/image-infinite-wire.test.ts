import { describe, expect, it } from 'vitest';
import {
  IMAGE_INFINITE_DROPPED_FIELDS,
  stripImageForInfiniteWire,
} from '~/server/utils/image-infinite-wire';

// `image.getInfinite` (the /images feed) is the #1 procedure by server time; its
// response is serialized synchronously with superjson on the event loop. This test
// pins the wire contract of the always-on field trim: the exact dropped set, the
// load-bearing retentions (fields that LOOK droppable but have a real consumer), and
// non-mutation. Type-level proof that no consumer reads a dropped field lives in the
// `next build` typecheck (the `ImagesInfiniteModel` narrowing), not here.

// A representative per-image object carrying every field the DB path (`getAllImages`)
// emits on the wire today (raw SQL SELECT + the item mapping).
const makeImage = () => ({
  // --- retained: rendered by the feed card / read by the seeded detail modal ---
  id: 123,
  url: 'abc.jpeg',
  name: 'a render',
  nsfwLevel: 1,
  width: 832,
  height: 1216,
  hash: 'UBFO~q00',
  hasMeta: true,
  hasPositivePrompt: true,
  onSite: false,
  remixOfId: null,
  type: 'image',
  metadata: { width: 832, height: 1216 },
  ingestion: 'Scanned',
  blockedFor: null,
  needsReview: null,
  postId: 8000,
  modelVersionId: 1500,
  minor: false,
  poi: false,
  model3dId: null,
  modelVersionIds: [1500],
  modelVersionIdsManual: [],
  publishedAt: new Date('2026-07-01T00:00:00.000Z'),
  collectionItemStatus: null,
  user: {
    id: 500,
    username: 'creator',
    image: null,
    deletedAt: null,
    cosmetics: [],
    profilePicture: null,
  },
  stats: { likeCountAllTime: 1, dislikeCountAllTime: 0 },
  reactions: [],
  cosmetic: null,
  thumbnailUrl: undefined,
  judgeScore: null,
  // --- retained: hidden-prefs `images` filter iterates it (biggest field) ---
  tagIds: [1, 2, 3, 4, 5],
  // --- retained: read by the seeded ImageDetail2 modal (card never reads them) ---
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  sortAt: new Date('2026-07-01T00:00:00.000Z'),
  // --- retained: typecheck found real readers (index: as-posts Newest sort;
  //     availability: BidModelButton) — kept, not forced out ---
  index: 0,
  availability: 'Public',
  // --- dropped: proven-unread across the whole ImagesInfiniteModel consumer graph ---
  scannedAt: new Date('2026-07-01T00:00:00.000Z'),
  mimeType: 'image/jpeg',
  postTitle: 'my post',
  hideMeta: false,
  acceptableMinor: false,
});

describe('image-infinite-wire', () => {
  describe('stripImageForInfiniteWire', () => {
    it('drops exactly the declared unread fields', () => {
      const out = stripImageForInfiniteWire(makeImage());
      for (const field of IMAGE_INFINITE_DROPPED_FIELDS) {
        expect(out).not.toHaveProperty(field);
      }
      // exactly these 7 and no others were removed
      const removed = Object.keys(makeImage()).filter((k) => !(k in out));
      expect(removed.sort()).toEqual([...IMAGE_INFINITE_DROPPED_FIELDS].sort());
    });

    it('keeps every field a consumer reads (card, hidden-prefs, seeded modal, OG)', () => {
      const out = stripImageForInfiniteWire(makeImage());
      for (const field of [
        'id',
        'url',
        'name',
        'nsfwLevel',
        'width',
        'height',
        'hash',
        'hasMeta',
        'hasPositivePrompt',
        'onSite',
        'remixOfId',
        'type',
        'metadata',
        'ingestion',
        'blockedFor',
        'needsReview',
        'postId',
        'modelVersionId',
        'minor',
        'poi',
        'model3dId',
        'modelVersionIds',
        'modelVersionIdsManual',
        'publishedAt',
        'collectionItemStatus',
        'user',
        'stats',
        'reactions',
        'cosmetic',
        'thumbnailUrl',
        'judgeScore',
      ]) {
        expect(out).toHaveProperty(field);
      }
      // 🔴 the load-bearing retentions: look droppable but ARE read (out of scope)
      expect(out).toHaveProperty('tagIds'); // client hidden-prefs filter
      expect((out as { tagIds: number[] }).tagIds).toEqual([1, 2, 3, 4, 5]);
      for (const field of ['createdAt', 'sortAt']) {
        expect(out).toHaveProperty(field); // read by the seeded ImageDetail2 modal (LAZY)
      }
      // 🔴 kept because the typecheck found real readers (not drop-safe after all)
      expect(out).toHaveProperty('index'); // as-posts ImageSort.Newest sort
      expect(out).toHaveProperty('availability'); // BidModelButton
      expect((out as { stats: Record<string, number> }).stats).toEqual({
        likeCountAllTime: 1,
        dislikeCountAllTime: 0,
      });
    });

    it('does NOT mutate the source object', () => {
      const source = makeImage();
      const before = JSON.stringify(source);
      const out = stripImageForInfiniteWire(source);
      expect(JSON.stringify(source)).toBe(before);
      expect(source).toHaveProperty('scannedAt');
      expect(out).not.toBe(source);
    });

    it('is a no-op for keys absent on the object (DB/Meili union safety)', () => {
      const out = stripImageForInfiniteWire({ id: 1, url: 'x', tagIds: [9] });
      expect(out).toEqual({ id: 1, url: 'x', tagIds: [9] });
    });

    it('removes the keys even when present as explicit null (the getAllImagesIndex shape)', () => {
      // The Meili/BitDex tRPC path (`getAllImagesIndex`) builds each item as an
      // object literal that sets `scannedAt`/`mimeType`/`postTitle` to `null`
      // explicitly. Those props SERIALIZE unless removed. Assert the strip deletes
      // the KEYS (not merely nulls them) so they leave the wire entirely.
      const indexShaped = {
        id: 7,
        url: 'y.jpeg',
        availability: 'Public', // kept (BidModelButton reads it)
        index: 3, // kept (as-posts Newest sort reads it)
        scannedAt: null,
        mimeType: null,
        postTitle: null,
        hideMeta: false,
        acceptableMinor: false,
      };
      const out = stripImageForInfiniteWire(indexShaped);
      for (const field of IMAGE_INFINITE_DROPPED_FIELDS) {
        expect(out).not.toHaveProperty(field); // key gone, not just null
      }
      expect(out).toEqual({ id: 7, url: 'y.jpeg', availability: 'Public', index: 3 });
    });
  });
});
