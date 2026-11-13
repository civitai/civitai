import type { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { ProtectedContext } from '~/server/createContext';
import type { StoredCommentV3 } from '~/server/services/commentv3/write.service';
import type * as ReactionService from '~/server/services/reaction.service';
import type * as Rewards from '~/server/rewards';

// The reaction gate reads the comment from CommentV3 alone: a live one reaches the reaction, and a
// deleted, ToS-hidden or missing one is not found to a member.

const { mockToggleReaction } = vi.hoisted(() => ({ mockToggleReaction: vi.fn() }));

vi.mock('~/server/services/reaction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactionService>()),
  toggleReaction: mockToggleReaction,
}));
vi.mock('~/server/rewards', async (importOriginal) => ({
  ...(await importOriginal<typeof Rewards>()),
  encouragementReward: { apply: vi.fn(async () => undefined) },
  goodContentReward: { apply: vi.fn(async () => undefined) },
}));

import { toggleReactionHandler } from '~/server/controllers/reaction.controller';

const COMMENT_ID = 3869052;

const v3Row = (over: Partial<StoredCommentV3> = {}): StoredCommentV3 => ({
  id: COMMENT_ID,
  entityType: 'article',
  entityId: 37795,
  parentId: null,
  replyToId: null,
  userId: 77,
  content: 'hi',
  hidden: false,
  tosViolation: false,
  locked: false,
  pinnedAt: null,
  deletedAt: null,
  depth: 0,
  path: String(COMMENT_ID),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function storeV3(row: StoredCommentV3 | undefined) {
  dbMock.dbWrite.$queryRawUnsafe.mockImplementation((async (sql: string, id: unknown) =>
    row && id === row.id && /FROM "CommentV3" WHERE id = \$1/.test(sql) ? [row] : []) as never);
}

const ctx = () =>
  ({
    user: { id: 5, isModerator: false },
    ip: '127.0.0.1',
    track: { reaction: vi.fn(async () => undefined) },
  } as unknown as ProtectedContext);

const react = () =>
  toggleReactionHandler({
    ctx: ctx(),
    input: { entityType: 'comment', entityId: COMMENT_ID, reaction: 'Like' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockToggleReaction.mockResolvedValue('created');
  // The article the comment is on; an unpublished one would gate the section.
  dbMock.dbRead.article.findUnique.mockResolvedValue({ userId: 1, status: 'Published' } as never);
});

describe('reaction.toggle on a comment', () => {
  it('reaches the reaction for a live article comment', async () => {
    storeV3(v3Row());
    await expect(react()).resolves.toBe('created');
    expect(mockToggleReaction).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'comment', entityId: COMMENT_ID })
    );
  });

  it.each([
    ['deleted', v3Row({ deletedAt: new Date() })],
    ['hidden for ToS', v3Row({ tosViolation: true })],
    ['missing', undefined],
  ])('answers not found when the comment is %s', async (_, row) => {
    storeV3(row);
    await expect(react()).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<TRPCError>);
    expect(mockToggleReaction).not.toHaveBeenCalled();
  });
});
