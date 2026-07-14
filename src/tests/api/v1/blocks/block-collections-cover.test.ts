import { describe, it, expect, vi } from 'vitest';

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
vi.mock('~/server/db/client', () => ({ dbRead: {} }));
vi.mock('~/server/auth/session-client', () => ({ sessionClient: {} }));

import { toCoverImageUrl } from '~/server/services/blocks/block-collections.service';

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
