import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CommentService from '~/server/services/comment.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installUserCosmeticCacheFake } from '~/test-utils/userCosmeticCacheFake';

const svc = vi.hoisted(() => ({ getComments: vi.fn(), getPinnedCommentsViaKysely: vi.fn() }));

vi.mock('~/server/services/comment.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentService>()),
  ...svc,
}));

// The showcase hat has its own cache and tests (events/showcase-hat.ts); here it only has to reach
// the right author.
const SHOWCASE_HAT = { cosmeticId: 5, url: 'hat.png', until: '2026-12-01T00:00:00.000Z' };
const showcase = vi.hoisted(() => ({
  getShowcaseHatsForUsers: vi.fn(
    async (_ids: number[]): Promise<Record<number, typeof SHOWCASE_HAT>> => ({})
  ),
}));
vi.mock('~/server/events/showcase-hat', () => ({ ...showcase, getShowcaseHatForUser: vi.fn() }));
const hatFor = (...owners: number[]) =>
  showcase.getShowcaseHatsForUsers.mockImplementation(async (ids: number[]) =>
    Object.fromEntries(ids.filter((id) => owners.includes(id)).map((id) => [id, SHOWCASE_HAT]))
  );

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
  svc.getPinnedCommentsViaKysely.mockResolvedValue([comment(3, PINNER)]);
});

const getAll = () =>
  getCommentsInfiniteHandler({ input: { modelId: 1 } as never, ctx: {} as never });

describe('comment.getAll authors', () => {
  // The pinned block reads through Kysely, whose author row is the id, username, deletedAt and
  // image only (hot-reads-4.reads.ts), so only the page's Prisma select can ask for more.
  it('does not ask Prisma for the author picture or cosmetics on the page', async () => {
    await getAll();

    const authorSelect = svc.getComments.mock.calls[0][0].select.user.select;
    expect(authorSelect).not.toHaveProperty('profilePicture');
    expect(authorSelect).not.toHaveProperty('cosmetics');
    expect(svc.getPinnedCommentsViaKysely).toHaveBeenCalledTimes(1);
  });

  it('carries each author picture and worn cosmetics from cache, read in one batch', async () => {
    hatFor(AUTHOR);
    const { comments } = await getAll();

    const badge = {
      data: null,
      cosmetic: { id: 1, data: { url: 'b.png' }, type: 'Badge', source: 'Event', name: 'Badge' },
    };
    expect(comments.map((c) => [c.id, c.user])).toStrictEqual([
      [3, { ...user(PINNER), profilePicture: null, showcaseHat: null, cosmetics: [badge] }],
      [1, { ...user(AUTHOR), profilePicture: picture, showcaseHat: SHOWCASE_HAT, cosmetics: [] }],
      [2, { ...user(PINNER), profilePicture: null, showcaseHat: null, cosmetics: [badge] }],
    ]);
    expect(dbMock.dbRead.userCosmetic.findMany).toHaveBeenCalledTimes(1);
  });
});
