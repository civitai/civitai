import { describe, expect, it } from 'vitest';
import {
  capImagesPerPost,
  IMAGES_AS_POSTS_DROPPED_IMAGE_FIELDS,
  IMAGES_AS_POSTS_PER_POST_CAP,
  stripImageForAsPostsWire,
} from '~/server/utils/images-as-posts-wire';

// `image.getImagesAsPostsInfinite` returns each post's FULL per-image object, and
// the tRPC response is serialized synchronously with superjson on the event loop.
// Two levers cut that cost:
//  - `stripImageForAsPostsWire` drops the OPTIONAL per-image fields no consumer of
//    this endpoint reads (zero-UX; the unread-but-required fields stay because the
//    card seeds `data.images` into the detail modal whose type demands them);
//  - `capImagesPerPost` caps a post's embedded images (material, flag-gated).
// This test pins the contract: the drop set, the load-bearing retentions, the cap,
// and non-mutation.

// A representative per-image object with every field the endpoint emits.
const makeImage = () => ({
  // --- retained: rendered by the card ---
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
  needsReview: null,
  userId: 500,
  postId: 8000,
  modelVersionId: 1500,
  minor: false,
  poi: false,
  modelVersionIds: [1500],
  modelVersionIdsManual: [],
  user: { id: 500, username: 'creator', image: null, deletedAt: null, cosmetics: [], profilePicture: null },
  stats: { likeCountAllTime: 1, dislikeCountAllTime: 0 },
  reactions: [],
  cosmetic: null,
  thumbnailUrl: undefined,
  // --- retained: read by the seeded ImageDetail2 modal (card never reads them) ---
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  publishedAt: new Date('2026-07-01T00:00:00.000Z'),
  sortAt: new Date('2026-07-01T00:00:00.000Z'),
  blockedFor: null,
  model3dId: null,
  // --- retained: hidden-prefs `case 'posts'` filters on it (biggest field) ---
  tagIds: [1, 2, 3, 4, 5],
  // --- retained: unread by all consumers, but NON-OPTIONAL on the modal seed type
  //     (dropping them fails typecheck at the `data.images -> ImageDetailModal` seed) ---
  hideMeta: false,
  scannedAt: new Date('2026-07-01T00:00:00.000Z'),
  mimeType: 'image/jpeg',
  index: 0,
  postTitle: 'my post',
  // --- dropped: unread AND optional on the seed type ---
  meta: null,
  availability: 'Public',
  acceptableMinor: false,
  baseModel: 'Illustrious',
  judgeScore: null,
});

describe('images-as-posts-wire', () => {
  describe('stripImageForAsPostsWire', () => {
    it('drops exactly the declared unread+optional fields', () => {
      const out = stripImageForAsPostsWire(makeImage());
      for (const field of IMAGES_AS_POSTS_DROPPED_IMAGE_FIELDS) {
        expect(out).not.toHaveProperty(field);
      }
      // exactly these 5 and no others were removed
      const removed = Object.keys(makeImage()).filter((k) => !(k in out));
      expect(removed.sort()).toEqual([...IMAGES_AS_POSTS_DROPPED_IMAGE_FIELDS].sort());
    });

    it('keeps every field a consumer reads (card, context menu, hidden-prefs, seeded modal)', () => {
      const out = stripImageForAsPostsWire(makeImage());
      for (const field of [
        'id', 'url', 'name', 'nsfwLevel', 'width', 'height', 'hash', 'hasMeta',
        'hasPositivePrompt', 'onSite', 'remixOfId', 'type', 'metadata', 'ingestion',
        'needsReview', 'userId', 'postId', 'modelVersionId', 'minor', 'poi',
        'modelVersionIds', 'modelVersionIdsManual', 'user', 'stats', 'reactions',
        'cosmetic', 'thumbnailUrl',
      ]) {
        expect(out).toHaveProperty(field);
      }
      // 🔴 the load-bearing retentions: look droppable but ARE read / ARE required
      expect(out).toHaveProperty('tagIds'); // hidden-prefs `case 'posts'`
      expect((out as { tagIds: number[] }).tagIds).toEqual([1, 2, 3, 4, 5]);
      for (const field of ['createdAt', 'publishedAt', 'sortAt', 'blockedFor', 'model3dId']) {
        expect(out).toHaveProperty(field); // read by the seeded ImageDetail2 modal
      }
      for (const field of ['hideMeta', 'scannedAt', 'mimeType', 'index', 'postTitle']) {
        expect(out).toHaveProperty(field); // required by the modal seed TYPE (unread but non-optional)
      }
      expect((out as { stats: Record<string, number> }).stats).toEqual({
        likeCountAllTime: 1,
        dislikeCountAllTime: 0,
      });
    });

    it('does NOT mutate the source object', () => {
      const source = makeImage();
      const before = JSON.stringify(source);
      const out = stripImageForAsPostsWire(source);
      expect(JSON.stringify(source)).toBe(before);
      expect(source).toHaveProperty('baseModel');
      expect(out).not.toBe(source);
    });

    it('is a no-op for keys absent on the object (DB/Meili union safety)', () => {
      const out = stripImageForAsPostsWire({ id: 1, url: 'x', tagIds: [9] });
      expect(out).toEqual({ id: 1, url: 'x', tagIds: [9] });
    });
  });

  describe('capImagesPerPost', () => {
    const imgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

    it('caps to IMAGES_AS_POSTS_PER_POST_CAP, keeping leading order (cover stays images[0])', () => {
      expect(IMAGES_AS_POSTS_PER_POST_CAP).toBe(12);
      const source = imgs(20);
      const out = capImagesPerPost(source);
      expect(out).toHaveLength(12);
      expect(out.map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(out[0]).toBe(source[0]);
      expect(source).toHaveLength(20); // not mutated
    });

    it('returns the same array untouched when within the cap (typical posts)', () => {
      const source = imgs(3);
      expect(capImagesPerPost(source)).toBe(source);
      expect(capImagesPerPost([])).toEqual([]);
    });

    it('honors a custom cap', () => {
      expect(capImagesPerPost(imgs(20), 8)).toHaveLength(8);
    });
  });
});
