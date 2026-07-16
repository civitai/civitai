import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CommentsV2 — `appListing` entity type (W13 app-store-listing comments).
 *
 * The reusable CommentsV2 service resolves/creates a listing's thread by
 * string-interpolating the parent column: `where: { [`${entityType}Id`]: entityId }`.
 * These tests pin that the NEW entity type `appListing` maps to the
 * `Thread.appListingId` column across the read / write / moderation paths — the
 * whole integration is "the column + the enum value exist", so this is the
 * behavioural contract that the feature rides on. No DB: `dbRead`/`dbWrite` are
 * mocked so we can assert the exact `where`/`data` the service builds.
 */

const { db } = vi.hoisted(() => {
  const tx = {
    thread: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 100, locked: false })),
    },
    commentV2: {
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 999 })),
    },
  };
  return {
    db: {
      tx,
      thread: {
        findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
        create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ locked: true })),
        update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ locked: true })),
      },
      commentV2: {
        create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 999 })),
        count: vi.fn(async (..._a: unknown[]): Promise<number> => 0),
        findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
        findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
        update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 1 })),
      },
      $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    },
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: db, dbWrite: db }));
// No blocklist round-trip in a unit test; the comment content passes.
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(async () => undefined),
}));
// otel `withSpan` → passthrough (avoid booting the telemetry SDK in node env).
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

import {
  getCommentCount,
  getCommentsInfinite,
  toggleLockCommentsThread,
  togglePinComment,
  upsertComment,
} from '../commentsv2.service';

/** The `where` of the last call to a mocked Prisma delegate method. */
function lastWhere(fn: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const arg = fn.mock.calls.at(-1)?.[0] as { where?: Record<string, unknown> } | undefined;
  return arg?.where ?? {};
}
function lastData(fn: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const arg = fn.mock.calls.at(-1)?.[0] as { data?: Record<string, unknown> } | undefined;
  return arg?.data ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CommentsV2 appListing thread resolution', () => {
  it('getCommentCount resolves the thread by appListingId', async () => {
    db.thread.findUnique.mockResolvedValueOnce({ commentCount: 7 });
    const count = await getCommentCount({ entityType: 'appListing', entityId: 42 });
    expect(count).toBe(7);
    // The crux: entityType 'appListing' → column `appListingId`.
    expect(lastWhere(db.thread.findUnique)).toEqual({ appListingId: 42 });
  });

  it('getCommentsInfinite resolves the thread by appListingId (returns null when absent)', async () => {
    db.thread.findUnique.mockResolvedValueOnce(null);
    const result = await getCommentsInfinite({
      entityType: 'appListing',
      entityId: 42,
      limit: 5,
    } as Parameters<typeof getCommentsInfinite>[0]);
    expect(result).toBeNull();
    expect(lastWhere(db.thread.findUnique)).toEqual({ appListingId: 42 });
  });

  it('upsertComment creates the thread with appListingId on first comment', async () => {
    db.thread.findUnique.mockResolvedValueOnce(null); // no existing thread
    await upsertComment({
      userId: 5,
      entityType: 'appListing',
      entityId: 42,
      content: 'great app',
    } as Parameters<typeof upsertComment>[0]);
    // The new thread is created keyed on the appListing surrogate.
    expect(lastData(db.tx.thread.create)).toMatchObject({ appListingId: 42 });
    // …and the comment attaches to that thread.
    expect(db.tx.commentV2.create).toHaveBeenCalledTimes(1);
  });

  it('is generic — a different entityType maps to its own column (model → modelId)', async () => {
    db.thread.findUnique.mockResolvedValueOnce({ commentCount: 1 });
    await getCommentCount({ entityType: 'model', entityId: 7 });
    expect(lastWhere(db.thread.findUnique)).toEqual({ modelId: 7 });
  });
});

describe('CommentsV2 appListing moderation inheritance', () => {
  it('lock (toggleLockCommentsThread) keys the thread on appListingId and creates it locked', async () => {
    db.thread.findUnique.mockResolvedValueOnce(null); // no thread yet
    const res = (await toggleLockCommentsThread({
      entityType: 'appListing',
      entityId: 42,
    })) as { locked: boolean };
    expect(lastWhere(db.thread.findUnique)).toEqual({ appListingId: 42 });
    // Creates the thread in the locked state, keyed on the surrogate.
    expect(lastData(db.thread.create)).toMatchObject({ appListingId: 42, locked: true });
    expect(res.locked).toBe(true);
  });

  it('lock toggles an existing appListing thread', async () => {
    db.thread.findUnique.mockResolvedValueOnce({ id: 100, locked: false });
    await toggleLockCommentsThread({ entityType: 'appListing', entityId: 42 });
    expect(lastWhere(db.thread.update)).toEqual({ appListingId: 42 });
    expect(lastData(db.thread.update)).toEqual({ locked: true });
  });

  it('pin (togglePinComment) flows through by comment id — entity-agnostic', async () => {
    db.commentV2.findUnique.mockResolvedValueOnce({ pinnedAt: null });
    await togglePinComment({ id: 999 });
    expect(lastWhere(db.commentV2.update)).toEqual({ id: 999 });
    // null → sets a pin timestamp.
    expect(lastData(db.commentV2.update).pinnedAt).toBeInstanceOf(Date);
  });
});
