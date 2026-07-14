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
vi.mock('~/client-utils/cf-images-utils', () => ({
  getEdgeUrl: (src: string, opts: Record<string, unknown>) => JSON.stringify({ src, ...opts }),
}));
const mockQueryRaw = vi.hoisted(() => vi.fn());
vi.mock('~/server/db/client', () => ({ dbRead: { $queryRaw: mockQueryRaw } }));
vi.mock('~/server/auth/session-client', () => ({ sessionClient: {} }));

import {
  getFallbackCoverImages,
  toCoverImageUrl,
} from '~/server/services/blocks/block-collections.service';

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

describe('getFallbackCoverImages (maturity clamp)', () => {
  beforeEach(() => mockQueryRaw.mockReset());

  it('no ids → no query, empty map', async () => {
    const map = await getFallbackCoverImages([], 3);
    expect(map.size).toBe(0);
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('threads browsingLevel into a BITWISE-clamped query and maps only url-bearing rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { collectionId: 10, url: 'sfw-10', type: 'image' },
      { collectionId: 11, url: 'clip-11', type: 'video' },
      { collectionId: 12, url: null, type: 'image' }, // no url → dropped (placeholder)
    ]);
    const map = await getFallbackCoverImages([10, 11, 12], 3);
    expect(map.get(10)).toEqual({ url: 'sfw-10', type: 'image' });
    expect(map.get(11)).toEqual({ url: 'clip-11', type: 'video' });
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

  it('a stricter ceiling is threaded through verbatim', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await getFallbackCoverImages([10], 1);
    const [, ...values] = mockQueryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(values).toContain(1);
  });
});
