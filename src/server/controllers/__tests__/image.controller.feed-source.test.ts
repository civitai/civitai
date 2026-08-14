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

  it('reports meili when BitDex fell back and the index said so', async () => {
    getAllImagesIndexMock.mockResolvedValue({ nextCursor: '10', items: [], source: 'meili' });

    const result = await getInfiniteImagesHandler({ input: indexBoundInput, ctx });

    expect(result.source).toBe('meili');
  });
});
