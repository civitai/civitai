import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * upsertComment (CommentsV2 service) must enforce user-blocking on the CREATE
 * branch only: a user blocked by the content owner can't add a comment, but
 * editing an existing comment (`data.id` set) skips the check.
 */

const { amIBlockedByUser, tx } = vi.hoisted(() => ({
  amIBlockedByUser: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
  // 🔴 `tx` stays a SEPARATE object from the write client, because every assertion below is
  // on `db.tx.*` and means "written inside the transaction". Inheriting the canonical
  // `$transaction` would hand the callback `dbMock.dbWrite` and collapse the two, so an
  // in-transaction create would start satisfying an assertion about a direct one.
  tx: {
    thread: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 100, locked: false })),
    },
    commentV2: {
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 999 })),
      // The edit path now runs inside the caller's transaction, so the sticker
      // charge and the comment write commit together.
      update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 5 })),
    },
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown> => []),
    $executeRaw: vi.fn(async (..._a: unknown[]): Promise<unknown> => 0),
  },
}));

// One local served both clients and hid a genuine split. `upsertComment` resolves the content
// owner through `getThreadEntityOwnerId`, which reads `image` on dbRead (commentsv2.service:172);
// its own thread lookup (:267) and the previous-content read on the edit path (:279) are dbWrite.
const db = {
  tx,
  image: dbMock.dbRead.image,
  thread: dbMock.dbWrite.thread,
  commentV2: dbMock.dbWrite.commentV2,
};

db.image.findUnique.mockResolvedValue({ userId: 100 });
db.commentV2.findUnique.mockResolvedValue({ content: '' });
dbMock.dbWrite.$transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) =>
  cb(tx)
);

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
    // The edit runs inside the transaction now, alongside the sticker charge.
    expect(db.tx.commentV2.update).toHaveBeenCalledTimes(1);
  });
});
