import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installUserCosmeticCacheFake } from '~/test-utils/userCosmeticCacheFake';

const { getCommentsInfinite } = await import('~/server/services/commentsv2.service');

/**
 * `commentv2.getInfinite` fills the authors of its Prisma-read comments — the pinned block, the
 * deep-linked target and the auto-expanded replies — from the user caches rather than from
 * relations nested in the select. Clients render every one of them with the same component, so
 * each must arrive in the nested-select shape.
 */

const PINNED_AUTHOR = 7;
const REPLY_AUTHOR = 8;
const TARGET_AUTHOR = 9;
const PAGE_AUTHOR = 6;
const THREAD = 10;
const REPLY_THREAD = 11;

const picture = {
  id: 501,
  name: 'me.png',
  url: 'uuid-1',
  nsfwLevel: 1,
  hash: 'U00000',
  userId: PINNED_AUTHOR,
  ingestion: 'Scanned',
  type: 'image',
  width: 512,
  height: 768,
  metadata: null,
};
const badge = {
  data: null,
  cosmetic: { id: 1, data: { url: 'b.png' }, type: 'Badge', source: 'Event', name: 'Badge' },
};
const user = (id: number) => ({ id, username: `u${id}`, deletedAt: null, image: null });
const comment = (id: number, authorId: number, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: THREAD,
  pinnedAt: null,
  reactionCount: 0,
  user: user(authorId),
  reactions: [],
  ...extra,
});
// The page itself is raw SQL that joins its authors' cosmetics in; it is left as it was.
const pageAuthor = { ...user(PAGE_AUTHOR), profilePicture: null, cosmetics: [] };

type Where = Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  installUserCosmeticCacheFake({
    userCosmetics: [
      {
        userId: REPLY_AUTHOR,
        cosmeticId: 1,
        data: null,
        equippedAt: new Date(),
        equippedToId: null,
      },
      {
        userId: TARGET_AUTHOR,
        cosmeticId: 2,
        data: { tint: 1 },
        equippedAt: new Date(),
        equippedToId: null,
      },
    ],
    cosmetics: [
      { id: 1, name: 'Badge', type: 'Badge', source: 'Event', data: { url: 'b.png' }, flags: 0 },
      { id: 2, name: 'Plate', type: 'NamePlate', source: 'Trophy', data: { c: 'red' }, flags: 0 },
    ],
    profilePictures: [picture],
    otherQueryRaw: (strings) => {
      const sql = strings.join('?');
      if (sql.includes('WITH RECURSIVE'))
        return [{ id: REPLY_THREAD, commentId: 2, locked: false, commentCount: 1, depth: 1 }];
      if (sql.includes('FROM "CommentV2" c'))
        return [{ ...comment(2, PAGE_AUTHOR), user: pageAuthor }];
      return [];
    },
  });
  dbMock.dbRead.thread.findUnique.mockResolvedValue({ id: THREAD } as never);
  dbMock.dbRead.commentV2.findMany.mockImplementation((async ({ where }: { where: Where }) => {
    if (where.pinnedAt) return [comment(1, PINNED_AUTHOR, { pinnedAt: new Date(0) })];
    return [comment(21, REPLY_AUTHOR, { threadId: REPLY_THREAD })];
  }) as never);
  dbMock.dbRead.commentV2.findFirst.mockResolvedValue(comment(99, TARGET_AUTHOR) as never);
  dbMock.dbRead.commentV2.groupBy.mockResolvedValue([
    { threadId: REPLY_THREAD, _count: { _all: 1 } },
  ] as never);
});

const list = () =>
  getCommentsInfinite({
    entityId: 1,
    entityType: 'image',
    limit: 20,
    repliesDepth: 1,
    targetCommentId: 99,
  } as Parameters<typeof getCommentsInfinite>[0]);

describe('commentv2.getInfinite authors', () => {
  it('does not ask Prisma for any author picture or cosmetics', async () => {
    await list();

    const calls = [
      ...dbMock.dbRead.commentV2.findMany.mock.calls,
      ...dbMock.dbRead.commentV2.findFirst.mock.calls,
    ];
    // Pinned block, replies, target.
    expect(calls).toHaveLength(3);
    for (const [args] of calls) {
      const authorSelect = (args as { select: { user: { select: object } } }).select.user.select;
      expect(authorSelect).not.toHaveProperty('profilePicture');
      expect(authorSelect).not.toHaveProperty('cosmetics');
    }
  });

  it('carries every author picture and worn cosmetics from cache, read in one batch', async () => {
    const result = await list();

    expect(result?.comments.map((c) => [c.id, c.user])).toStrictEqual([
      [1, { ...user(PINNED_AUTHOR), profilePicture: picture, cosmetics: [] }],
      [2, pageAuthor],
    ]);
    expect(result?.replyThreads.map((t) => t.comments.map((c) => [c.id, c.user]))).toStrictEqual([
      [[21, { ...user(REPLY_AUTHOR), profilePicture: null, cosmetics: [badge] }]],
    ]);
    expect(result?.targetComment?.user).toStrictEqual({
      ...user(TARGET_AUTHOR),
      profilePicture: null,
      cosmetics: [
        {
          data: { tint: 1 },
          cosmetic: {
            id: 2,
            data: { c: 'red' },
            type: 'NamePlate',
            source: 'Trophy',
            name: 'Plate',
          },
        },
      ],
    });

    expect(dbMock.dbRead.userCosmetic.findMany).toHaveBeenCalledTimes(1);
    const { userId } = dbMock.dbRead.userCosmetic.findMany.mock.calls[0][0].where;
    expect([...userId.in].sort()).toEqual([PINNED_AUTHOR, REPLY_AUTHOR, TARGET_AUTHOR]);
  });
});
