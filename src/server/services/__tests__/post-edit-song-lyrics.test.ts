import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as Caches from '~/server/redis/caches';
import type * as TagService from '~/server/services/tag.service';
import type { SessionUser } from '~/types/session';

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));
vi.mock('~/server/services/tag.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TagService>()),
  getVotableImageTags: vi.fn(async () => []),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    thumbnailCache: { ...actual.thumbnailCache, fetch: vi.fn(async () => ({})) },
  };
});

import { getPostEditImages } from '~/server/services/post.service';

const row = (id: number, type: 'audio' | 'image') => ({
  id,
  index: id,
  type,
  tools: [],
  techniques: [],
});
const lines = [
  { t: null, text: '[Verse 1]' },
  { t: 1200, text: 'rain on the glass' },
];

beforeEach(() => vi.clearAllMocks());

describe("the post editor's songs", () => {
  it('carry their stored lyric lines, read in one query for the whole post', async () => {
    vi.mocked(dbMock.dbRead.image.findMany).mockResolvedValue([
      row(1, 'audio'),
      row(2, 'audio'),
      row(3, 'image'),
    ] as never);
    vi.mocked(dbMock.dbRead.trackLyrics.findMany).mockResolvedValue([
      { imageId: 1, lines },
    ] as never);

    const images = await getPostEditImages({ id: 1, user: { id: 1 } as SessionUser });

    expect(images.map((x) => [x.id, x.lyrics])).toEqual([
      [1, lines],
      [2, null],
      [3, null],
    ]);
    expect(dbMock.dbRead.trackLyrics.findMany).toHaveBeenCalledTimes(1);
  });

  it('carry no lyrics for a song whose stored lines are not lyric lines', async () => {
    vi.mocked(dbMock.dbRead.image.findMany).mockResolvedValue([
      row(1, 'audio'),
      row(2, 'audio'),
    ] as never);
    vi.mocked(dbMock.dbRead.trackLyrics.findMany).mockResolvedValue([
      { imageId: 1, lines: [{ t: 'soon', text: 'rain' }] },
      { imageId: 2, lines },
    ] as never);

    const images = await getPostEditImages({ id: 1, user: { id: 1 } as SessionUser });

    expect(images.map((x) => [x.id, x.lyrics])).toEqual([
      [1, null],
      [2, lines],
    ]);
  });

  it('skip the lyrics read for a post without songs', async () => {
    vi.mocked(dbMock.dbRead.image.findMany).mockResolvedValue([row(3, 'image')] as never);

    const images = await getPostEditImages({ id: 1, user: { id: 1 } as SessionUser });

    expect(images[0].lyrics).toBeNull();
    expect(dbMock.dbRead.trackLyrics.findMany).not.toHaveBeenCalled();
  });
});
