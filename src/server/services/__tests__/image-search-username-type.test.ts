import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';

/**
 * `/api/v1/images` publishes `username` as a STRING. civitai#4768 /
 * civitai/cli#513: it emitted a bare JSON number for an all-digit username, and
 * an external Go client failed to decode the entire 200 with
 * `cannot unmarshal number into Go struct field .items.username of type string`.
 *
 * The CAUSE is upstream — the feed's Redis entity cache inferred the field's
 * type from its stored text — and is guarded by
 * `feed-cache-value-codec.test.ts`. This file guards the OTHER half: the
 * published wire contract, at the one place that builds it.
 *
 * 🔴 It is a belt, not the fix, and the third case below says so as an
 * assertion rather than as a comment: a number that has already lost its leading
 * zeros casts to a string that is still the WRONG NAME. A guard that only
 * checked `typeof === 'string'` would call that a pass.
 */

vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlags: vi.fn(() => ({ canViewNsfw: true, datapacketRead: false })),
  buildFliptContext: vi.fn(() => ({})),
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: {},
  getFliptVariant: vi.fn(async () => 'off'),
}));
vi.mock('~/server/redis/caches', () => ({
  imageMetaCache: { fetch: vi.fn(async () => ({})) },
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: vi.fn(() => 'https://edge/x') }));

const feedSearch = vi.fn(async () => ({ items: [] as unknown[], nextCursor: undefined }));
const legacySearch = vi.fn(async () => ({ items: [] as unknown[], nextCursor: undefined }));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: (...args: unknown[]) => legacySearch(...(args as [])),
  getAllImagesIndex: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  getImagesFromFeedSearch: (...args: unknown[]) => feedSearch(...(args as [])),
}));

import { runImageSearch } from '../image-search.service';

const req = {
  headers: { 'user-agent': 'probe/1.0' },
  socket: { remoteAddress: '203.0.113.7' },
} as unknown as NextApiRequest;

function itemWithUsername(username: unknown) {
  return {
    id: 1446527,
    url: 'abc',
    hash: 'h',
    width: 512,
    height: 768,
    nsfwLevel: 1,
    type: 'image',
    createdAt: new Date(0),
    postId: 369748,
    stats: {},
    user: { id: 4768, username },
    baseModel: 'SD 1.5',
    modelVersionIds: [],
    tags: [],
  };
}

/** Drive the REAL service over the feed (non-legacy) branch. */
async function usernameFromFeed(raw: unknown) {
  feedSearch.mockResolvedValue({ items: [itemWithUsername(raw)], nextCursor: undefined });
  const { items } = await runImageSearch(
    { limit: 1, withMeta: false, withTags: false, data: {} } as never,
    { browsingLevel: 1, user: undefined, req } as never
  );
  return items[0].username;
}

/** Drive the REAL service over the legacy (`?imageId=`) branch. */
async function usernameFromLegacy(raw: unknown) {
  legacySearch.mockResolvedValue({ items: [itemWithUsername(raw)], nextCursor: undefined });
  const { items } = await runImageSearch(
    { limit: 1, withMeta: false, withTags: false, data: { imageId: 1446527 } } as never,
    { browsingLevel: 1, user: undefined, req } as never
  );
  return items[0].username;
}

describe('runImageSearch: the published type of `username`', () => {
  beforeEach(() => {
    feedSearch.mockClear();
    legacySearch.mockClear();
  });

  it('POSITIVE CONTROL: the harness reaches both branches and can tell them apart', async () => {
    await usernameFromFeed('alice');
    expect(feedSearch).toHaveBeenCalledTimes(1);
    expect(legacySearch).not.toHaveBeenCalled();

    await usernameFromLegacy('bob');
    expect(legacySearch).toHaveBeenCalledTimes(1);
    expect(feedSearch).toHaveBeenCalledTimes(1);
  });

  it('emits a string when the feed hands it a number', async () => {
    const username = await usernameFromFeed(2428023993);
    expect(username).toBe('2428023993');
    expect(typeof username).toBe('string');
  });

  it('CANNOT restore a name the cache already destroyed — this belt is not the fix', async () => {
    // `0222` reached the wire as `222` because the cache decoded the stored text
    // as a number. Casting at this boundary produces a well-typed 200 carrying a
    // name that matches no account, which is why the cache fix is the real one.
    const username = await usernameFromFeed(222);
    expect(username).toBe('222');
    expect(username).not.toBe('0222');
  });

  it('leaves an ordinary string untouched', async () => {
    expect(await usernameFromFeed('0222')).toBe('0222');
    expect(await usernameFromLegacy('2428023993')).toBe('2428023993');
  });

  it('does not turn a null username into the string "null"', async () => {
    // The legacy Prisma branch can carry a null username for a deleted account.
    // A bare `String(...)` here would publish `'null'` as somebody's name.
    expect(await usernameFromLegacy(null)).toBeNull();
    expect(await usernameFromFeed(undefined)).toBeUndefined();
  });
});
