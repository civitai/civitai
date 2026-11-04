import type { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { ProtectedContext } from '~/server/createContext';
import type { StoredCommentV3 } from '~/server/services/commentv3/write.service';
import type * as ReactionService from '~/server/services/reaction.service';
import type * as Rewards from '~/server/rewards';

// A comment on a surface that writes CommentV3 directly (articles) has no CommentV2 row. The
// reaction gate read only CommentV2, so every reaction on one answered "No comment with id".

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
import { isCommentGoneForMembers } from '~/server/services/commentsv2.service';

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
  dbMock.dbWrite.commentV2.findUnique.mockResolvedValue(null as never);
});

describe('reaction.toggle on a comment that exists only in CommentV3', () => {
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
    ['on a surface that still writes CommentV2', v3Row({ entityType: 'post' })],
    ['missing from both tables', undefined],
  ])('answers not found when the comment is %s', async (_, row) => {
    storeV3(row);
    await expect(react()).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<TRPCError>);
    expect(mockToggleReaction).not.toHaveBeenCalled();
  });
});

describe('isCommentGoneForMembers', () => {
  it('keeps the CommentV2 answer when that row exists', async () => {
    storeV3(v3Row({ deletedAt: new Date() }));
    dbMock.dbWrite.commentV2.findUnique.mockResolvedValue({ tosViolation: false } as never);
    await expect(isCommentGoneForMembers(COMMENT_ID)).resolves.toBe(false);
    dbMock.dbWrite.commentV2.findUnique.mockResolvedValue({ tosViolation: true } as never);
    await expect(isCommentGoneForMembers(COMMENT_ID)).resolves.toBe(true);
  });

  it('still answers gone for a detached CommentV2 comment', async () => {
    dbMock.dbWrite.commentV2.findUnique.mockResolvedValue({ tosViolation: false } as never);
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([{ detached: true }] as never);
    await expect(isCommentGoneForMembers(COMMENT_ID)).resolves.toBe(true);
  });
});
