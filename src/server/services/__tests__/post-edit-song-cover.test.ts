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

const POST = 70;
const OWNER = 5;

type Row = {
  id: number;
  userId: number;
  postId: number | null;
  type: 'audio' | 'image';
  url: string;
  metadata: Record<string, unknown> | null;
  ingestion: string;
  nsfwLevel: number;
  blockedFor: string | null;
};

/** The `Image` table the editor reads: post media by `postId`, anything else by id. */
let table: Row[] = [];
/** The `Track` table: each song's cover link. */
let tracks: { imageId: number; coverImageId: number | null; genre: string | null }[] = [];

function image(id: number, values: Partial<Row> = {}): Row {
  return {
    id,
    userId: OWNER,
    postId: null,
    type: 'image',
    url: `key-${id}`,
    metadata: null,
    ingestion: 'Scanned',
    nsfwLevel: 1,
    blockedFor: null,
    ...values,
  };
}
/** A song, linked to `coverImageId` through its `Track` row. */
const song = (id: number, coverImageId?: number) => {
  if (coverImageId !== undefined) tracks.push({ imageId: id, coverImageId, genre: null });
  return image(id, { postId: POST, type: 'audio', metadata: { duration: 90 } });
};
const coverOf = (id: number, songId: number, values: Partial<Row> = {}) =>
  image(id, { metadata: { parentId: songId }, ...values });

beforeEach(() => {
  vi.clearAllMocks();
  tracks = [];
  vi.mocked(dbMock.dbRead.track.findMany).mockImplementation((async ({
    where,
  }: {
    where: { imageId: { in: number[] } };
  }) => tracks.filter((x) => where.imageId.in.includes(x.imageId))) as never);
  vi.mocked(dbMock.dbRead.image.findMany).mockImplementation((async ({
    where,
    select,
  }: {
    where: { postId?: number; id?: { in: number[] } };
    select: Record<string, unknown>;
  }) => {
    const found =
      where.postId !== undefined
        ? table.filter((x) => x.postId === where.postId)
        : table.filter((x) => where.id?.in.includes(x.id));
    return found
      .map((x) => ({ ...x, index: x.id, tools: [], techniques: [] }))
      .map((x) => Object.fromEntries(Object.entries(x).filter(([key]) => select[key])));
  }) as never);
});

const read = () =>
  getPostEditImages({ id: POST, user: { id: OWNER } as SessionUser, servableLevels: 31 });

describe("the post editor's song covers", () => {
  it('carry each cover with its scan state, read in one query, and are not among the media', async () => {
    table = [
      song(1, 101),
      song(2, 102),
      song(3),
      image(4, { postId: POST }),
      coverOf(101, 1),
      coverOf(102, 2, { ingestion: 'Blocked', nsfwLevel: 32, blockedFor: 'moderated' }),
    ];

    const images = await read();

    expect(images.map((x) => [x.id, x.cover])).toEqual([
      [1, { id: 101, url: 'key-101', ingestion: 'Scanned', nsfwLevel: 1, blockedFor: null }],
      [
        2,
        { id: 102, url: 'key-102', ingestion: 'Blocked', nsfwLevel: 32, blockedFor: 'moderated' },
      ],
      [3, null],
      [4, null],
    ]);
    // The post's media read, one read of the songs' Track rows, and one read for every cover.
    expect(dbMock.dbRead.image.findMany).toHaveBeenCalledTimes(2);
    expect(dbMock.dbRead.track.findMany).toHaveBeenCalledTimes(1);
  });

  // No writer links another song's cover: each links a row made for its own song. The unique
  // `Track.coverImageId` only stops two songs sharing one.
  it("is null when the linked image is gone, someone else's, or a post image", async () => {
    table = [
      song(1, 404),
      song(2, 102),
      song(3, 103),
      coverOf(102, 2, { userId: 6 }),
      coverOf(103, 3, { postId: POST + 1 }),
    ];

    const images = await read();

    expect(images.map((x) => x.cover)).toEqual([null, null, null]);
  });

  it("carry the song's genre from its Track row, its genre's tag left out of the song's tags", async () => {
    table = [song(1)];
    tracks = [{ imageId: 1, coverImageId: null, genre: 'Pop' }];
    // The song's owner-managed tag rows: the genre's mirror and one the owner added.
    vi.mocked(dbMock.dbRead.$queryRaw).mockResolvedValue([
      { imageId: 1, id: 21, name: 'chill' },
      { imageId: 1, id: 20, name: 'pop' },
    ] as never);

    const [image] = await read();

    expect(image.genre).toBe('Pop');
    expect(image.songTags).toEqual([{ id: 21, name: 'chill' }]);
  });

  it('skip the cover read for a post whose songs have none', async () => {
    table = [song(1), image(2, { postId: POST })];

    await read();

    expect(dbMock.dbRead.image.findMany).toHaveBeenCalledTimes(1);
  });
});
