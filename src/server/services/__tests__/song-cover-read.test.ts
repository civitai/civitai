import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as ImageVisibility from '~/server/services/image-visibility.service';
import type { SessionUser } from '~/types/session';

const mocks = vi.hoisted(() => ({ music: true, visible: new Set<number>() }));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlagsLazy: () => ({ music: mocks.music }),
}));
// The image visibility rule has its own tests; here it decides which songs the requester sees.
vi.mock('~/server/services/image-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageVisibility>()),
  getImageIdsVisibleToViewer: vi.fn(async ({ ids }: { ids: number[] }) => {
    return new Set(ids.filter((id) => mocks.visible.has(id)));
  }),
}));

import { getSongCoversForPlayer } from '~/server/services/post.service';

const OWNER = 5;
const LISTENER = { id: 9 } as SessionUser;

type Row = {
  id: number;
  userId: number;
  postId: number | null;
  type: 'audio' | 'image';
  url: string;
  hash: string | null;
  metadata: Record<string, unknown> | null;
  ingestion: string;
  nsfwLevel: number;
  blockedFor: string | null;
  needsReview: string | null;
};

let table: Row[] = [];

function image(id: number, values: Partial<Row> = {}): Row {
  return {
    id,
    userId: OWNER,
    postId: null,
    type: 'image',
    url: `key-${id}`,
    hash: `hash-${id}`,
    metadata: null,
    ingestion: 'Scanned',
    nsfwLevel: 1,
    blockedFor: null,
    needsReview: null,
    ...values,
  };
}
const song = (id: number, coverImageId?: number) =>
  image(id, {
    postId: 70,
    type: 'audio',
    metadata: { duration: 90, ...(coverImageId !== undefined && { coverImageId }) },
  });
const coverOf = (id: number, songId: number, values: Partial<Row> = {}) =>
  image(id, { metadata: { parentId: songId }, ...values });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.music = true;
  vi.mocked(dbMock.dbRead.image.findMany).mockImplementation((async ({
    where,
    select,
  }: {
    where: { id: { in: number[] } };
    select: Record<string, unknown>;
  }) =>
    table
      .filter((x) => where.id.in.includes(x.id))
      .map((x) => Object.fromEntries(Object.entries(x).filter(([key]) => select[key])))) as never);
});

const read = (ids: number[], user: SessionUser | undefined = LISTENER) =>
  getSongCoversForPlayer({ ids, user });

describe('the global player reads song covers', () => {
  it('returns a scanned cover the requester may see, with only the fields the player shows', async () => {
    table = [song(1, 101), coverOf(101, 1, { nsfwLevel: 4 })];
    mocks.visible = new Set([1]);

    expect(await read([1])).toEqual([
      { songId: 1, id: 101, url: 'key-101', hash: 'hash-101', nsfwLevel: 4 },
    ]);
  });

  it('leaves out pending, blocked, held and missing covers', async () => {
    table = [
      song(1, 101),
      song(2, 102),
      song(3, 103),
      song(4, 104),
      song(5, 404),
      song(6),
      coverOf(101, 1, { ingestion: 'Pending' }),
      coverOf(102, 2, { ingestion: 'Blocked', blockedFor: 'moderated', nsfwLevel: 32 }),
      coverOf(103, 3, { blockedFor: 'AiNotVerified' }),
      coverOf(104, 4, { needsReview: 'minor' }),
    ];
    mocks.visible = new Set([1, 2, 3, 4, 5, 6]);

    expect(await read([1, 2, 3, 4, 5, 6])).toEqual([]);
  });

  it("leaves out a cover that is not the song's own: someone else's, in a post, or another song's", async () => {
    table = [
      song(1, 101),
      song(2, 102),
      song(3, 103),
      coverOf(101, 1, { userId: 6 }),
      coverOf(102, 2, { postId: 71 }),
      coverOf(103, 1),
    ];
    mocks.visible = new Set([1, 2, 3]);

    expect(await read([1, 2, 3])).toEqual([]);
  });

  it('returns nothing for a song the requester cannot see', async () => {
    table = [song(1, 101), coverOf(101, 1)];
    mocks.visible = new Set();

    expect(await read([1])).toEqual([]);
  });

  it("gives the song's owner the same rule as everyone else", async () => {
    table = [song(1, 101), coverOf(101, 1, { ingestion: 'Pending' })];
    mocks.visible = new Set([1]);

    expect(await read([1], { id: OWNER } as SessionUser)).toEqual([]);
  });

  it('refuses without the music flag, before reading anything', async () => {
    mocks.music = false;
    table = [song(1, 101), coverOf(101, 1)];
    mocks.visible = new Set([1]);

    await expect(read([1])).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(dbMock.dbRead.image.findMany).not.toHaveBeenCalled();
  });
});
