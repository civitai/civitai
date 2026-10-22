import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CommentService from '~/server/services/comment.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installUserCosmeticCacheFake } from '~/test-utils/userCosmeticCacheFake';

const svc = vi.hoisted(() => ({ getComments: vi.fn(), getPinnedComments: vi.fn() }));

vi.mock('~/server/services/comment.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentService>()),
  ...svc,
}));

const { getCommentsInfiniteHandler } = await import('~/server/controllers/comment.controller');

/**
 * `comment.getAll` fills each author's profile picture and worn cosmetics from the user caches
 * rather than from relations nested in its Prisma select. The model page renders the authors from
 * this payload, so they must arrive in the nested-select shape.
 */

const AUTHOR = 7;
const PINNER = 8;
const picture = {
  id: 501,
  name: 'me.png',
  url: 'uuid-1',
  nsfwLevel: 1,
  hash: 'U00000',
  userId: AUTHOR,
  ingestion: 'Scanned',
  type: 'image',
  width: 512,
  height: 768,
  metadata: null,
};
const user = (id: number) => ({ id, username: `u${id}`, deletedAt: null, image: null });
const comment = (id: number, authorId: number) => ({
  id,
  content: 'hi',
  user: user(authorId),
  reactions: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  installUserCosmeticCacheFake({
    userCosmetics: [
      { userId: PINNER, cosmeticId: 1, data: null, equippedAt: new Date(), equippedToId: null },
    ],
    cosmetics: [
      { id: 1, name: 'Badge', type: 'Badge', source: 'Event', data: { url: 'b.png' }, flags: 0 },
    ],
    profilePictures: [picture],
  });
  svc.getComments.mockResolvedValue([comment(1, AUTHOR), comment(2, PINNER)]);
  svc.getPinnedComments.mockResolvedValue([comment(3, PINNER)]);
});

const getAll = () =>
  getCommentsInfiniteHandler({ input: { modelId: 1 } as never, ctx: {} as never });

describe('comment.getAll authors', () => {
  it('does not ask Prisma for the author picture or cosmetics, on the page or the pinned block', async () => {
    await getAll();

    for (const fn of [svc.getComments, svc.getPinnedComments]) {
      const authorSelect = fn.mock.calls[0][0].select.user.select;
      expect(authorSelect).not.toHaveProperty('profilePicture');
      expect(authorSelect).not.toHaveProperty('cosmetics');
    }
  });

  it('carries each author picture and worn cosmetics from cache, read in one batch', async () => {
    const { comments } = await getAll();

    const badge = {
      data: null,
      cosmetic: { id: 1, data: { url: 'b.png' }, type: 'Badge', source: 'Event', name: 'Badge' },
    };
    expect(comments.map((c) => [c.id, c.user])).toStrictEqual([
      [3, { ...user(PINNER), profilePicture: null, cosmetics: [badge] }],
      [1, { ...user(AUTHOR), profilePicture: picture, cosmetics: [] }],
      [2, { ...user(PINNER), profilePicture: null, cosmetics: [badge] }],
    ]);
    expect(dbMock.dbRead.userCosmetic.findMany).toHaveBeenCalledTimes(1);
  });
});
