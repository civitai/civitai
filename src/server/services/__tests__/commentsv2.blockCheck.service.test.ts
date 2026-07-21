import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * upsertComment (CommentsV2 service) must enforce user-blocking on the CREATE
 * branch only: a user blocked by the content owner can't add a comment, but
 * editing an existing comment (`data.id` set) skips the check.
 */

const { db, amIBlockedByUser } = vi.hoisted(() => {
  const amIBlockedByUser = vi.fn(async (..._a: unknown[]): Promise<boolean> => false);
  const tx = {
    thread: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 100, locked: false })),
    },
    commentV2: { create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 999 })) },
  };
  return {
    db: {
      tx,
      image: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ userId: 100 })) },
      thread: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
      commentV2: {
        create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 999 })),
        update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 5 })),
      },
      $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    },
    amIBlockedByUser,
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: db, dbWrite: db }));
vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser }));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

import { upsertComment } from '../commentsv2.service';

const baseCreate = {
  userId: 7,
  entityType: 'image',
  entityId: 1,
  content: 'hello',
} as Parameters<typeof upsertComment>[0];

beforeEach(() => {
  vi.clearAllMocks();
  amIBlockedByUser.mockResolvedValue(false);
});

describe('upsertComment — block enforcement on create', () => {
  it('throws and never creates when the author is blocked by the content owner', async () => {
    amIBlockedByUser.mockResolvedValueOnce(true);
    await expect(upsertComment({ ...baseCreate })).rejects.toThrow();
    expect(db.tx.commentV2.create).not.toHaveBeenCalled();
  });

  it('allows a non-blocked author to create', async () => {
    await expect(upsertComment({ ...baseCreate })).resolves.toMatchObject({ id: 999 });
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: 7, targetUserId: 100 });
    expect(db.tx.commentV2.create).toHaveBeenCalledTimes(1);
  });

  it('exempts moderators from the block check', async () => {
    amIBlockedByUser.mockResolvedValue(true);
    await expect(
      upsertComment({ ...baseCreate, isModerator: true } as Parameters<typeof upsertComment>[0])
    ).resolves.toMatchObject({ id: 999 });
    expect(amIBlockedByUser).not.toHaveBeenCalled();
  });

  it('skips the block check when editing an existing comment (data.id set)', async () => {
    amIBlockedByUser.mockResolvedValue(true);
    await expect(
      upsertComment({ ...baseCreate, id: 5 } as Parameters<typeof upsertComment>[0])
    ).resolves.toMatchObject({ id: 5 });
    expect(amIBlockedByUser).not.toHaveBeenCalled();
    expect(db.commentV2.update).toHaveBeenCalledTimes(1);
  });
});
