import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

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

const { tx } = vi.hoisted(() => ({
  // 🔴 Kept as a SEPARATE object from the write client: `tx.thread.create` / `tx.commentV2.create`
  // are asserted below and mean "created inside upsertComment's transaction". The canonical
  // `$transaction` default would hand the callback `dbMock.dbWrite` and collapse that distinction.
  tx: {
    thread: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 100, locked: false })),
    },
    commentV2: {
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 999 })),
    },
  },
}));

// 🔴 One local served both clients, and `thread.findUnique` is driven here by FOUR entry points
// that do not agree on the client — so this file splits per CASE, not per path:
//   getCommentCount        commentsv2.service:433   dbRead
//   getCommentsInfinite                      :741   dbRead
//   upsertComment                            :267   dbWrite
//   toggleLockCommentsThread                 :471   dbWrite   (+ .create :478, .update :487)
// and togglePinComment reads `commentV2` on dbRead (:505) and writes it on dbWrite (:508).
const read = dbMock.dbRead;
const write = dbMock.dbWrite;

write.thread.create.mockResolvedValue({ locked: true });
write.thread.update.mockResolvedValue({ locked: true });
write.commentV2.update.mockResolvedValue({ id: 1 });
write.$transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
// No blocklist round-trip in a unit test; the comment content passes.
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedCommentContent: vi.fn(async () => undefined),
}));
// otel `withSpan` → passthrough (avoid booting the telemetry SDK in node env).
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));
// upsertComment now runs a block check; stub the block resolver's user lookup so
// the heavy real user.service module isn't pulled into this unit test.
vi.mock('~/server/services/user.service', () => ({
  amIBlockedByUser: vi.fn(async () => false),
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
    read.thread.findUnique.mockResolvedValueOnce({ id: 100 });
    read.commentV2.count.mockResolvedValueOnce(7);
    const count = await getCommentCount({ entityType: 'appListing', entityId: 42 });
    expect(count).toBe(7);
    // The crux: entityType 'appListing' → column `appListingId`.
    expect(lastWhere(read.thread.findUnique)).toEqual({ appListingId: 42 });
  });

  it('getCommentsInfinite resolves the thread by appListingId (returns null when absent)', async () => {
    read.thread.findUnique.mockResolvedValueOnce(null);
    const result = await getCommentsInfinite({
      entityType: 'appListing',
      entityId: 42,
      limit: 5,
    } as Parameters<typeof getCommentsInfinite>[0]);
    expect(result).toBeNull();
    expect(lastWhere(read.thread.findUnique)).toEqual({ appListingId: 42 });
  });

  it('upsertComment creates the thread with appListingId on first comment', async () => {
    write.thread.findUnique.mockResolvedValueOnce(null); // no existing thread
    await upsertComment({
      userId: 5,
      entityType: 'appListing',
      entityId: 42,
      content: 'great app',
    } as Parameters<typeof upsertComment>[0]);
    // The new thread is created keyed on the appListing surrogate.
    expect(lastData(tx.thread.create)).toMatchObject({ appListingId: 42 });
    // …and the comment attaches to that thread.
    expect(tx.commentV2.create).toHaveBeenCalledTimes(1);
  });

  it('is generic — a different entityType maps to its own column (model → modelId)', async () => {
    read.thread.findUnique.mockResolvedValueOnce({ commentCount: 1 });
    await getCommentCount({ entityType: 'model', entityId: 7 });
    expect(lastWhere(read.thread.findUnique)).toEqual({ modelId: 7 });
  });
});

describe('CommentsV2 appListing moderation inheritance', () => {
  it('lock (toggleLockCommentsThread) keys the thread on appListingId and creates it locked', async () => {
    write.thread.findUnique.mockResolvedValueOnce(null); // no thread yet
    const res = (await toggleLockCommentsThread({
      entityType: 'appListing',
      entityId: 42,
    })) as { locked: boolean };
    expect(lastWhere(write.thread.findUnique)).toEqual({ appListingId: 42 });
    // Creates the thread in the locked state, keyed on the surrogate.
    expect(lastData(write.thread.create)).toMatchObject({ appListingId: 42, locked: true });
    expect(res.locked).toBe(true);
  });

  it('lock toggles an existing appListing thread', async () => {
    write.thread.findUnique.mockResolvedValueOnce({ id: 100, locked: false });
    await toggleLockCommentsThread({ entityType: 'appListing', entityId: 42 });
    expect(lastWhere(write.thread.update)).toEqual({ appListingId: 42 });
    expect(lastData(write.thread.update)).toEqual({ locked: true });
  });

  it('pin (togglePinComment) flows through by comment id — entity-agnostic', async () => {
    read.commentV2.findUnique.mockResolvedValueOnce({ pinnedAt: null });
    await togglePinComment({ id: 999 });
    expect(lastWhere(write.commentV2.update)).toEqual({ id: 999 });
    // null → sets a pin timestamp.
    expect(lastData(write.commentV2.update).pinnedAt).toBeInstanceOf(Date);
  });
});
