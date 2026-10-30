import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as OgImageHelpers from '~/server/utils/og-image-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { fetchImageAsDataUri } = vi.hoisted(() => ({ fetchImageAsDataUri: vi.fn() }));
vi.mock('~/server/utils/og-image-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof OgImageHelpers>()),
  fetchImageAsDataUri,
}));

import handler from '~/pages/api/og';

const OWNER_ID = 10;
const VERSION_ID = 20;

type Row = {
  id: number;
  postId: number;
  index: number;
  url: string;
  post: { userId: number; availability: string };
};

// Evaluates the parts of the query that decide WHICH image is picked: the mocked client
// ignores `where` and `orderBy`, so without this any query would return the first row.
function fakeFindFirst(rows: Row[]) {
  return async ({ where, orderBy }: any) => {
    const p = where.post ?? {};
    const keys: Array<Record<string, 'asc' | 'desc'>> = Array.isArray(orderBy)
      ? orderBy
      : [orderBy];
    const hit = rows
      .filter((r) => p.userId === undefined || r.post.userId === p.userId)
      .filter((r) => p.availability === undefined || r.post.availability === p.availability)
      .sort((a, b) => {
        for (const key of keys) {
          const [field, dir] = Object.entries(key)[0] as [keyof Row, 'asc' | 'desc'];
          const d = (a[field] as number) - (b[field] as number);
          if (d) return dir === 'asc' ? d : -d;
        }
        return 0;
      })[0];
    return hit ? { url: hit.url, nsfwLevel: 1, type: 'image', width: 100, height: 100 } : null;
  };
}

const render = async () => {
  const res = {
    status: vi.fn(() => res),
    setHeader: vi.fn(() => res),
    send: vi.fn(() => res),
    json: vi.fn(() => res),
    end: vi.fn(() => res),
  } as unknown as NextApiResponse;
  await handler(
    { method: 'GET', query: { type: 'model', id: '1' }, headers: {} } as unknown as NextApiRequest,
    res
  );
};

const pickedUrl = () => {
  const url = String(fetchImageAsDataUri.mock.calls[0]?.[0] ?? '');
  return url.match(/(owner|other)-[a-z0-9-]+/)?.[0] ?? null;
};

const mockModel = (userId: number) =>
  dbMock.dbRead.model.findFirst.mockResolvedValue({
    name: 'M',
    description: '',
    meta: null,
    userId,
    user: { username: 'creator', settings: null },
    modelVersions: [{ id: VERSION_ID, description: '' }],
  });

beforeEach(() => {
  vi.clearAllMocks();
  fetchImageAsDataUri.mockResolvedValue(null);
  dbMock.dbRead.modelMetric.findUnique.mockResolvedValue(null);
  mockModel(OWNER_ID);
});

describe('/api/og?type=model cover image', () => {
  it("shows the creator's image over another user's earlier-indexed one", async () => {
    dbMock.dbRead.image.findFirst.mockImplementation(
      fakeFindFirst([
        {
          id: 1,
          postId: 5,
          index: 0,
          url: 'other-first',
          post: { userId: 99, availability: 'Public' },
        },
        {
          id: 2,
          postId: 6,
          index: 1,
          url: 'owner-cover',
          post: { userId: OWNER_ID, availability: 'Public' },
        },
      ])
    );
    await render();
    expect(pickedUrl()).toBe('owner-cover');
  });

  it('skips a post that is not public', async () => {
    dbMock.dbRead.image.findFirst.mockImplementation(
      fakeFindFirst([
        {
          id: 1,
          postId: 5,
          index: 0,
          url: 'owner-hidden',
          post: { userId: OWNER_ID, availability: 'Private' },
        },
        {
          id: 2,
          postId: 6,
          index: 0,
          url: 'owner-cover',
          post: { userId: OWNER_ID, availability: 'Public' },
        },
      ])
    );
    await render();
    expect(pickedUrl()).toBe('owner-cover');
  });

  it('takes the earliest post, not the lowest index across posts, like the model page', async () => {
    dbMock.dbRead.image.findFirst.mockImplementation(
      fakeFindFirst([
        {
          id: 3,
          postId: 8,
          index: 0,
          url: 'owner-later-post',
          post: { userId: OWNER_ID, availability: 'Public' },
        },
        {
          id: 2,
          postId: 6,
          index: 1,
          url: 'owner-cover',
          post: { userId: OWNER_ID, availability: 'Public' },
        },
      ])
    );
    await render();
    expect(pickedUrl()).toBe('owner-cover');
  });

  it('renders no cover when only other users have posted', async () => {
    dbMock.dbRead.image.findFirst.mockImplementation(
      fakeFindFirst([
        {
          id: 1,
          postId: 5,
          index: 0,
          url: 'other-first',
          post: { userId: 99, availability: 'Public' },
        },
      ])
    );
    await render();
    expect(fetchImageAsDataUri).not.toHaveBeenCalled();
  });

  it("uses any user's image for a system-account model, like the model page", async () => {
    mockModel(-1);
    dbMock.dbRead.image.findFirst.mockImplementation(
      fakeFindFirst([
        {
          id: 1,
          postId: 5,
          index: 0,
          url: 'other-first',
          post: { userId: 99, availability: 'Public' },
        },
      ])
    );
    await render();
    expect(pickedUrl()).toBe('other-first');
  });
});
