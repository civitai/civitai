import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as OgImageHelpers from '~/server/utils/og-image-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { NsfwLevel } from '~/server/common/enums';

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
  nsfwLevel?: number;
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
      .filter((r) => !where.nsfwLevel?.in || where.nsfwLevel.in.includes(r.nsfwLevel ?? 1))
      .filter((r) => where.id === undefined || r.id === where.id)
      .sort((a, b) => {
        for (const key of keys) {
          const [field, dir] = Object.entries(key)[0] as [keyof Row, 'asc' | 'desc'];
          const d = (a[field] as number) - (b[field] as number);
          if (d) return dir === 'asc' ? d : -d;
        }
        return 0;
      })[0];
    return hit
      ? { url: hit.url, nsfwLevel: hit.nsfwLevel ?? 1, type: 'image', width: 100, height: 100 }
      : null;
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
  return res;
};

const pickedUrl = () => {
  const url = String(fetchImageAsDataUri.mock.calls[0]?.[0] ?? '');
  return url.match(/(owner|other)-[a-z0-9-]+/)?.[0] ?? null;
};

const mockModel = (userId: number, extra: object = {}) =>
  dbMock.dbRead.model.findFirst.mockResolvedValue({
    ...extra,
    name: 'M',
    description: '',
    meta: null,
    userId,
    user: { username: 'creator', settings: null },
    modelVersions: [{ id: VERSION_ID, description: '' }],
  });

beforeEach(() => {
  vi.clearAllMocks();
  // Reset, not just cleared: an implementation set by one test must not reach the next.
  redisMock.redis.get.mockReset();
  fetchImageAsDataUri.mockResolvedValue(null);
  dbMock.dbRead.modelMetric.findUnique.mockResolvedValue(null);
  mockModel(OWNER_ID);
});

describe('/api/og?type=model cover image', () => {
  it("picks a minor or SFW-only model's first image within its gallery level", async () => {
    redisMock.redis.get.mockImplementation(async (key: string) =>
      key.startsWith('model:gallery-settings:')
        ? JSON.stringify({ level: NsfwLevel.PG, hiddenTags: [], hiddenUsers: [], sfwHeld: true })
        : null
    );
    const rows = (nsfwLevel: number) => [
      {
        id: 1,
        postId: 5,
        index: 0,
        url: 'owner-first',
        nsfwLevel,
        post: { userId: OWNER_ID, availability: 'Public' },
      },
      {
        id: 2,
        postId: 6,
        index: 0,
        url: 'owner-second',
        nsfwLevel: NsfwLevel.PG,
        post: { userId: OWNER_ID, availability: 'Public' },
      },
    ];
    dbMock.dbRead.image.findFirst.mockImplementation(fakeFindFirst(rows(NsfwLevel.PG13)));
    await render();
    expect(pickedUrl()).toBe('owner-second');
  });

  const coverRows = [
    {
      id: 3,
      postId: 4,
      index: 0,
      url: 'owner-cover',
      nsfwLevel: NsfwLevel.PG13,
      post: { userId: OWNER_ID, availability: 'Public' },
    },
    {
      id: 2,
      postId: 6,
      index: 0,
      url: 'owner-second',
      nsfwLevel: NsfwLevel.PG,
      post: { userId: OWNER_ID, availability: 'Public' },
    },
  ];

  it("passes over a chosen cover above a minor or SFW-only model's gallery level", async () => {
    mockModel(OWNER_ID, { coverImageId: 3 });
    redisMock.redis.get.mockImplementation(async (key: string) =>
      key.startsWith('model:gallery-settings:')
        ? JSON.stringify({ level: NsfwLevel.PG, hiddenTags: [], hiddenUsers: [], sfwHeld: true })
        : null
    );
    dbMock.dbRead.image.findFirst.mockImplementation(fakeFindFirst(coverRows));
    await render();
    expect(pickedUrl()).toBe('owner-second');
  });

  it('shows the chosen cover of a model that is not held', async () => {
    mockModel(OWNER_ID, { coverImageId: 3 });
    dbMock.dbRead.image.findFirst.mockImplementation(fakeFindFirst(coverRows));
    await render();
    expect(pickedUrl()).toBe('owner-cover');
  });

  it('serves the short-lived fallback card when the gallery settings cannot be read', async () => {
    redisMock.redis.get.mockImplementation(async (key: string) => {
      if (key.startsWith('model:gallery-settings:')) throw new Error('redis down');
      return null;
    });
    dbMock.dbRead.image.findFirst.mockImplementation(fakeFindFirst(coverRows));
    const res = await render();
    expect(fetchImageAsDataUri).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'public, max-age=3600, s-maxage=3600'
    );
  });

  it('keeps the first image of a model that is not held', async () => {
    dbMock.dbRead.image.findFirst.mockImplementation(
      fakeFindFirst([
        {
          id: 1,
          postId: 5,
          index: 0,
          url: 'owner-first',
          nsfwLevel: NsfwLevel.PG13,
          post: { userId: OWNER_ID, availability: 'Public' },
        },
        {
          id: 2,
          postId: 6,
          index: 0,
          url: 'owner-second',
          nsfwLevel: NsfwLevel.PG,
          post: { userId: OWNER_ID, availability: 'Public' },
        },
      ])
    );
    await render();
    expect(pickedUrl()).toBe('owner-first');
  });

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
