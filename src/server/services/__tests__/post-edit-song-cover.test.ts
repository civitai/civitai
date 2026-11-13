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
const song = (id: number, coverImageId?: number) =>
  image(id, {
    postId: POST,
    type: 'audio',
    metadata: { duration: 90, ...(coverImageId !== undefined && { coverImageId }) },
  });
const coverOf = (id: number, songId: number, values: Partial<Row> = {}) =>
  image(id, { metadata: { parentId: songId }, ...values });

beforeEach(() => {
  vi.clearAllMocks();
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

const read = () => getPostEditImages({ id: POST, user: { id: OWNER } as SessionUser });

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
    // The post's media read plus one read for every cover.
    expect(dbMock.dbRead.image.findMany).toHaveBeenCalledTimes(2);
  });

  it("is null when the linked image is gone, someone else's, a post image or another song's", async () => {
    table = [
      song(1, 404),
      song(2, 102),
      song(3, 103),
      song(4, 104),
      coverOf(102, 2, { userId: 6 }),
      coverOf(103, 3, { postId: POST + 1 }),
      coverOf(104, 1),
    ];

    const images = await read();

    expect(images.map((x) => x.cover)).toEqual([null, null, null, null]);
  });

  it('skip the cover read for a post whose songs have none', async () => {
    table = [song(1), image(2, { postId: POST })];

    await read();

    expect(dbMock.dbRead.image.findMany).toHaveBeenCalledTimes(1);
  });
});
