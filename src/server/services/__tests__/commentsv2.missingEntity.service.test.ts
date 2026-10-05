import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { upsertComment } from '../commentsv2.service';

/**
 * A comment's `Thread` row carries an FK to the entity it hangs off. When that entity is gone —
 * a deleted image whose page still rendered a comment box — `thread.create` rejects with a P2003
 * naming the constraint (`Thread_imageId_fkey`). Left alone it reaches the user as a raw Prisma
 * error; `upsertComment` must turn it into a plain not-found the caller can read.
 */

const db = dbMock.dbWrite;

const base = {
  userId: 7,
  entityType: 'image',
  entityId: 142688928,
  content: 'hello',
} as Parameters<typeof upsertComment>[0];

const fkViolation = () =>
  new Prisma.PrismaClientKnownRequestError(
    'Foreign key constraint violated on the constraint: `Thread_imageId_fkey`',
    { code: 'P2003', clientVersion: 'test' }
  );

beforeEach(() => {
  vi.clearAllMocks();
  // No thread exists yet for this entity, so the create path runs.
  db.thread.findUnique.mockResolvedValue(null);
  db.commentV2.create.mockResolvedValue({ id: 999 });
});

describe('upsertComment — commenting on a missing entity', () => {
  it('translates the thread FK violation into a not-found instead of leaking the raw Prisma error', async () => {
    db.thread.create.mockRejectedValue(fkViolation());

    const promise = upsertComment({ ...base });
    await expect(promise).rejects.toThrow('this image no longer exists');
    // The DB constraint name must not survive into the message the caller sees.
    await expect(promise).rejects.not.toThrow('Thread_imageId_fkey');
    expect(db.commentV2.create).not.toHaveBeenCalled();
  });

  it('does not relabel a foreign-key violation that comes from elsewhere in the transaction', async () => {
    db.thread.create.mockResolvedValue({
      id: 100,
      locked: false,
      rootThreadId: null,
      parentThreadId: null,
    });
    // A P2003 from the comment insert (not the thread→entity FK) must not be reported as a
    // missing entity — the catch is scoped to `thread.create` for exactly this reason.
    db.commentV2.create.mockRejectedValue(fkViolation());

    await expect(upsertComment({ ...base })).rejects.not.toThrow('no longer exists');
  });

  it('leaves an ordinary create untouched when the entity exists', async () => {
    db.thread.create.mockResolvedValue({
      id: 100,
      locked: false,
      rootThreadId: null,
      parentThreadId: null,
    });

    await expect(upsertComment({ ...base })).resolves.toMatchObject({ id: 999 });
    expect(db.commentV2.create).toHaveBeenCalledTimes(1);
  });
});
