import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '~/server/createContext';
import type * as FliptClient from '~/server/flipt/client';
import type * as ImageService from '~/server/services/image.service';

/**
 * The BitDex feed notice is gated on the `source` this handler emits, so the
 * handler is where the guard actually lives. Both branches must name themselves:
 * an unnamed DB page is indistinguishable from an index page that returned
 * nothing, and the client then cannot tell "the flag went off mid-session" from
 * "you reached the end of the feed" — the first must take the notice down, the
 * second must not.
 */

const { getAllImagesMock, getAllImagesIndexMock, getFliptVariantMock } = vi.hoisted(() => ({
  getAllImagesMock: vi.fn(),
  getAllImagesIndexMock: vi.fn(),
  getFliptVariantMock: vi.fn(),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages: getAllImagesMock,
  getAllImagesIndex: getAllImagesIndexMock,
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  getFliptVariant: getFliptVariantMock,
}));

import { getInfiniteImagesHandler } from '../image.controller';

const ctx = {
  user: { id: 7, isModerator: false },
  features: { imageIndexFeed: false, canViewNsfw: true, datapacketRead: false },
  req: { headers: {} },
  ip: '127.0.0.1',
} as unknown as Context;

// `postId` forces requiresDbPath, which is how a query reaches getAllImages
// regardless of the flag.
const dbBoundInput = { limit: 10, browsingLevel: 1, include: [], postId: 5 } as never;
const indexBoundInput = { limit: 10, browsingLevel: 1, include: [] } as never;
// What the remix / challenge / add-to-collection submit pickers send: "show me
// something of mine to submit". The index can serve this shape, which is why it
// used to — and why a freshly published image was missing from the picker for
// as long as the index took to catch up (measured on prod 2026-08-27: 26 of a
// 40-image cohort were still unindexed 13 minutes after publish).
const pickerInput = {
  limit: 50,
  browsingLevel: 1,
  include: [],
  userId: 7,
  publishedOnly: true,
} as never;

describe('getInfiniteImagesHandler names the backend that served the page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllImagesMock.mockResolvedValue({ nextCursor: '10', items: [] });
    getAllImagesIndexMock.mockResolvedValue({ nextCursor: '10', items: [], source: 'bitdex' });
    getFliptVariantMock.mockResolvedValue('primary');
  });

  it('reports db when the query can only be served by the database', async () => {
    const result = await getInfiniteImagesHandler({ input: dbBoundInput, ctx });

    expect(getAllImagesMock).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('db');
  });

  // The flag going off mid-session routes later pages here while earlier pages
  // came from BitDex. Unstamped, those pages read as "no backend" and the notice
  // survives over database results.
  it('reports db when BitDex is off and the database serves a broad query', async () => {
    getFliptVariantMock.mockResolvedValue('off');

    const result = await getInfiniteImagesHandler({ input: indexBoundInput, ctx });

    expect(getAllImagesMock).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('db');
  });

  it('passes the index path’s own source through untouched', async () => {
    const result = await getInfiniteImagesHandler({ input: indexBoundInput, ctx });

    expect(getAllImagesIndexMock).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('bitdex');
  });

  // 🔴 The picker beats BitDex on purpose, and that is the point of the test.
  // `requiresImageDbPath` is evaluated BEFORE the Flipt call, so a DB-bound
  // query never even asks what BitDex mode is in. If someone moves the Flipt
  // evaluation above that check, or reorders the `useIndex` expression so
  // `useBitdex` wins, this goes red — and nothing else in the suite would.
  it('serves the own-content submit picker from the database even with BitDex primary', async () => {
    getFliptVariantMock.mockResolvedValue('primary');

    const result = await getInfiniteImagesHandler({ input: pickerInput, ctx });

    expect(getAllImagesMock).toHaveBeenCalledTimes(1);
    expect(getAllImagesIndexMock).not.toHaveBeenCalled();
    expect(result.source).toBe('db');
    // Not merely unused — never consulted. The short-circuit is what keeps a
    // BitDex rollout from silently taking the picker back to the index.
    expect(getFliptVariantMock).not.toHaveBeenCalled();
  });

  // 🔴 Both halves of the routing pair are plain URL params, so without the
  // caller check in the handler this is `/images?userId=<anyone>&publishedOnly=true`
  // pinning an arbitrary creator's feed to raw SQL for any visitor. The pickers
  // only ever send the signed-in user's own id, so scoping costs the fix nothing.
  it('leaves another creator on the index even with publishedOnly set', async () => {
    const result = await getInfiniteImagesHandler({
      input: { ...(pickerInput as object), userId: 999 } as never,
      ctx,
    });

    expect(getAllImagesIndexMock).toHaveBeenCalledTimes(1);
    expect(getAllImagesMock).not.toHaveBeenCalled();
    // Withdrawn, not forwarded — the flag only suppresses the caller's own
    // unpublished carve-out, which cannot match rows scoped to someone else.
    expect(getAllImagesIndexMock.mock.calls[0][0].publishedOnly).toBeUndefined();
    expect(result.source).toBe('bitdex');
  });

  it('leaves a broad feed on the index when only publishedOnly is set', async () => {
    // The control for the case above: it is the PAIR that routes. Without a
    // userId this is a site-wide feed, and routing it to the DB would be a
    // broad-feed escape hatch anyone could type into a URL.
    const result = await getInfiniteImagesHandler({
      input: { limit: 10, browsingLevel: 1, include: [], publishedOnly: true } as never,
      ctx,
    });

    expect(getAllImagesIndexMock).toHaveBeenCalledTimes(1);
    expect(getAllImagesMock).not.toHaveBeenCalled();
  });

  it('reports meili when BitDex fell back and the index said so', async () => {
    getAllImagesIndexMock.mockResolvedValue({ nextCursor: '10', items: [], source: 'meili' });

    const result = await getInfiniteImagesHandler({ input: indexBoundInput, ctx });

    expect(result.source).toBe('meili');
  });
});
