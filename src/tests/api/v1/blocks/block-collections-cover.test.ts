import { beforeEach, describe, it, expect, vi } from 'vitest';

/**
 * Unit coverage for the REAL `toCoverImageUrl` (the endpoint test mocks it). The
 * feedback fix: a collection cover must always be `<img>`-renderable, so a VIDEO
 * cover has to resolve to a transcoded still frame (poster), never the raw `.mp4`.
 *
 * `getEdgeUrl` reaches into client-only modules at import; the block service's DB
 * client is irrelevant here — both are mocked so we exercise only the option
 * shaping `toCoverImageUrl` performs.
 */

// Echo the args so we can assert exactly what getEdgeUrl was asked to produce.
vi.mock('~/client-utils/edge-url', () => ({
  getEdgeUrl: (src: string, opts: Record<string, unknown>) => JSON.stringify({ src, ...opts }),
}));
const mockQueryRaw = dbMock.dbRead.$queryRaw;
vi.mock('~/server/auth/session-client', () => ({ sessionClient: {} }));

import {
  getFallbackCoverImages,
  toCoverFields,
  toCoverImageUrl,
} from '~/server/services/blocks/block-collections.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

describe('toCoverImageUrl', () => {
  it('returns null when the image / url is missing', () => {
    expect(toCoverImageUrl(null)).toBeNull();
    expect(toCoverImageUrl(undefined)).toBeNull();
    expect(toCoverImageUrl({ url: null, type: 'image' })).toBeNull();
    expect(toCoverImageUrl({ url: '', type: 'image' })).toBeNull();
  });

  it('a still IMAGE cover renders as an image (no transcode)', () => {
    const out = JSON.parse(toCoverImageUrl({ url: 'abc', type: 'image' })!);
    expect(out.src).toBe('abc');
    expect(out.type).toBe('image');
    expect(out.original).toBe(true);
    expect(out.transcode).toBeUndefined();
  });

  it('a VIDEO cover renders as a transcoded, non-animated POSTER (image), not raw video', () => {
    const out = JSON.parse(toCoverImageUrl({ url: 'clip', type: 'video' })!);
    expect(out.src).toBe('clip');
    // Rendered as an image (poster), NOT type: 'video' — an <img> can't play mp4.
    expect(out.type).toBe('image');
    expect(out.transcode).toBe(true);
    expect(out.anim).toBe(false);
  });
});

describe('toCoverFields', () => {
  it('🔴 NO COVER → the level field is ABSENT, not 0', () => {
    // `0` is a REAL level (unrated). A consumer branches on `undefined` (no claim →
    // use its own domain ceiling) versus any supplied value (authoritative), so
    // emitting 0 for "there is no cover" silently moves it onto the other path.
    for (const noImage of [null, undefined, { url: null, type: 'image' }, { url: '', type: 'image' }]) {
      const fields = toCoverFields(noImage);
      expect(fields.coverImageUrl).toBeNull();
      // The KEY must be missing — `{ coverNsfwLevel: undefined }` would serialise
      // away too, but asserting on the key is what pins the omission itself.
      expect('coverNsfwLevel' in fields).toBe(false);
      expect(Object.keys(fields)).toEqual(['coverImageUrl']);
    }
  });

  it('🔴 an UNRATED (0) cover publishes a real 0 — the field is present', () => {
    // The mirror of the case above, and the reason the absence test is not enough
    // on its own: 0 must survive as a value rather than collapsing into "absent".
    const fields = toCoverFields({ url: 'k', type: 'image', nsfwLevel: 0 });
    expect(fields.coverNsfwLevel).toBe(0);
    expect('coverNsfwLevel' in fields).toBe(true);
  });

  it('publishes the level verbatim for a rated cover', () => {
    expect(toCoverFields({ url: 'k', type: 'image', nsfwLevel: 1 }).coverNsfwLevel).toBe(1);
    expect(toCoverFields({ url: 'k', type: 'image', nsfwLevel: 4 }).coverNsfwLevel).toBe(4);
    expect(toCoverFields({ url: 'k', type: 'image', nsfwLevel: 28 }).coverNsfwLevel).toBe(28);
  });

  it('a cover with a null/absent level is UNRATED (0), because it HAS a cover', () => {
    expect(toCoverFields({ url: 'k', type: 'image', nsfwLevel: null }).coverNsfwLevel).toBe(0);
    expect(toCoverFields({ url: 'k', type: 'image' }).coverNsfwLevel).toBe(0);
  });

  it('🔴 the url and the level come from THE SAME image — both halves move together', () => {
    // The pairing is the whole point: a level describing an image other than the
    // one in `coverImageUrl` is worse than no level at all, because the consumer
    // treats a supplied level as authoritative.
    const a = toCoverFields({ url: 'image-a', type: 'image', nsfwLevel: 1 });
    const b = toCoverFields({ url: 'image-b', type: 'image', nsfwLevel: 16 });
    expect(JSON.parse(a.coverImageUrl!).src).toBe('image-a');
    expect(a.coverNsfwLevel).toBe(1);
    expect(JSON.parse(b.coverImageUrl!).src).toBe('image-b');
    expect(b.coverNsfwLevel).toBe(16);
  });

  it('a VIDEO cover keeps the poster shaping AND carries that video item\'s level', () => {
    const fields = toCoverFields({ url: 'clip', type: 'video', nsfwLevel: 2 });
    const out = JSON.parse(fields.coverImageUrl!);
    expect(out.type).toBe('image');
    expect(out.transcode).toBe(true);
    expect(fields.coverNsfwLevel).toBe(2);
  });

  it('does NOT emit a bare `nsfwLevel` key (that name means the COLLECTION bitmask)', () => {
    // Invariant guard, not regression coverage: a Collection's own `nsfwLevel` is
    // OR-ed over its items and cannot separate a 97%-safe collection from a
    // 1%-safe one, so the two names must never be confusable on this response.
    const fields = toCoverFields({ url: 'k', type: 'image', nsfwLevel: 4 }) as Record<string, unknown>;
    expect('nsfwLevel' in fields).toBe(false);
  });
});

describe('getFallbackCoverImages (maturity clamp)', () => {
  beforeEach(() => mockQueryRaw.mockReset());

  it('no ids → no query, empty map', async () => {
    const map = await getFallbackCoverImages([], 3);
    expect(map.size).toBe(0);
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('threads browsingLevel into a BITWISE-clamped query and maps only url-bearing rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { collectionId: 10, url: 'sfw-10', type: 'image', nsfwLevel: 1 },
      { collectionId: 11, url: 'clip-11', type: 'video', nsfwLevel: 2 },
      { collectionId: 12, url: null, type: 'image', nsfwLevel: 1 }, // no url → dropped
    ]);
    const map = await getFallbackCoverImages([10, 11, 12], 3);
    expect(map.get(10)).toEqual({ url: 'sfw-10', type: 'image', nsfwLevel: 1 });
    expect(map.get(11)).toEqual({ url: 'clip-11', type: 'video', nsfwLevel: 2 });
    expect(map.has(12)).toBe(false);

    // The raw tagged-template call must carry the browsingLevel (3) as a bound
    // value and use a bitwise nsfwLevel predicate + DISTINCT ON so the newest
    // PERMITTED item per collection is selected (not filtered-after-distinct).
    const call = mockQueryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const [strings, ...values] = call;
    const sql = strings.join(' ? ');
    expect(sql).toContain('"nsfwLevel" &');
    expect(sql).toContain('DISTINCT ON (ci."collectionId")');
    expect(sql).toContain('ORDER BY ci."collectionId", ci."createdAt" DESC');
    expect(values).toContain(3);
  });

  it('🔴 SELECTS the item nsfwLevel, so a fallback cover can publish ITS OWN level', async () => {
    // The level is not merely a filter predicate here: the endpoint publishes the
    // level of the cover it serves, and for a fallback cover THIS row is that
    // cover. Selecting only (url,type) is what forces the endpoint to describe the
    // primary image it just rejected.
    mockQueryRaw.mockResolvedValueOnce([{ collectionId: 10, url: 'k', type: 'image', nsfwLevel: 4 }]);
    const map = await getFallbackCoverImages([10], 7);
    expect(map.get(10)?.nsfwLevel).toBe(4);

    const [strings] = mockQueryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    // The projection, not the WHERE clause: an aliased select of the column.
    expect(strings.join(' ? ')).toContain('i."nsfwLevel" as "nsfwLevel"');
  });

  it('a NULL nsfwLevel column reads as the real level 0 (unrated), never dropped', async () => {
    // Unrated is a value, not an absence — a row with a null level still yields a
    // usable cover, and `0` is what the wire must carry for it.
    mockQueryRaw.mockResolvedValueOnce([{ collectionId: 10, url: 'k', type: 'image', nsfwLevel: null }]);
    const map = await getFallbackCoverImages([10], 3);
    expect(map.get(10)).toEqual({ url: 'k', type: 'image', nsfwLevel: 0 });
  });

  it('🔴 SEAM: a fallback map value feeds toCoverFields and its level survives verbatim', async () => {
    // The two halves of this change meet here — `getFallbackCoverImages` carries a
    // level and `toCoverFields` publishes it. Each is green on its own even if the
    // map value and the projection's input shape disagree; this is the only
    // assertion that loads BOTH surfaces.
    mockQueryRaw.mockResolvedValueOnce([
      { collectionId: 10, url: 'fallback-key', type: 'image', nsfwLevel: 2 },
    ]);
    const map = await getFallbackCoverImages([10], 3);
    const fields = toCoverFields(map.get(10));
    expect(fields.coverNsfwLevel).toBe(2);
    expect(JSON.parse(fields.coverImageUrl!).src).toBe('fallback-key');
  });

  it('a stricter ceiling is threaded through verbatim', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await getFallbackCoverImages([10], 1);
    const [, ...values] = mockQueryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(values).toContain(1);
  });
});
