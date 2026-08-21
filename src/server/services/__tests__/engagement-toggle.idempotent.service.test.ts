import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Regression test for the prod 500-floor bug class:
//   Invalid `prisma.modelEngagement.create()` — Unique constraint failed on
//   (userId, modelId)  (~0.26/hr, still 500ing after #2798 fixed the sibling
//   modelVersionEngagement.create).
// "Toggle" engagement procedures read-then-create: two concurrent calls both
// see "absent" and both create; the loser hits the unique constraint (P2002).
// Since the engagement now exists, a toggle is idempotent — the loser must
// resolve to the SAME success value (and run the same side-effects) instead of
// bubbling a 500.

import { Prisma } from '@prisma/client';

const { refreshCache } = vi.hoisted(() => ({
  refreshCache: vi.fn(async () => undefined),
}));

// One local served both clients, so the bounty toggle's READ was indistinguishable from its
// writes. `toggleModelEngagement` does every modelEngagement operation on `dbWrite`
// (user.service:822); `toggleUserBountyEngagement` reads `bountyEngagement` on `dbRead`
// (:2270) and writes it on `dbWrite` (:2276, :2284).
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

// `create`/`update`/`delete` have no canonical default and the service reads what they return.
for (const fn of [
  mockDbWrite.modelEngagement.create,
  mockDbWrite.bountyEngagement.create,
  mockDbWrite.bountyEngagement.delete,
]) {
  fn.mockResolvedValue({});
}
// `toggleModelEngagement` writes through `deleteMany`/`updateMany` scoped by the type
// it READ — never the PK alone — and reads the row count back. A row matched by
// default, so a test that means "a concurrent writer replaced it" has to say so.
mockDbWrite.modelEngagement.deleteMany.mockResolvedValue({ count: 1 });
mockDbWrite.modelEngagement.updateMany.mockResolvedValue({ count: 1 });
// HiddenModels.refreshCache is the side-effect the Hide success path runs and
// MUST still run on a P2002. Stub the whole user-preferences module surface that
// user.service reaches for at import time.
vi.mock('~/server/services/user-preferences.service', () => ({
  HiddenModels: { refreshCache },
  HiddenModels3D: { refreshCache: vi.fn(async () => undefined) },
  HiddenUsers: { refreshCache: vi.fn(async () => undefined) },
  HiddenImages: { refreshCache: vi.fn(async () => undefined) },
  HiddenTags: { refreshCache: vi.fn(async () => undefined) },
  BlockedUsers: { refreshCache: vi.fn(async () => undefined), getCached: vi.fn(async () => []) },
  BlockedByUsers: { refreshCache: vi.fn(async () => undefined) },
  ImplicitHiddenImages: { refreshCache: vi.fn(async () => undefined) },
  toggleHidden: vi.fn(async () => ({ added: [], removed: [] })),
}));

import { toggleModelEngagement, toggleUserBountyEngagement } from '~/server/services/user.service';

const p2002 = (target: string[]) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '1',
    meta: { target },
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toggleModelEngagement — idempotent on P2002 race (the confirmed prod 500)', () => {
  it('Hide: P2002 on create → returns true AND still refreshes the HiddenModels cache', async () => {
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce(null);
    mockDbWrite.modelEngagement.create.mockRejectedValueOnce(p2002(['userId', 'modelId']));

    const result = await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Hide' });

    expect(result).toBe(true);
    // The Hide success path's side-effect must still run on the idempotent path.
    expect(refreshCache).toHaveBeenCalledWith({ userId: 42 });
  });

  it('Notify: P2002 on create → returns true (no cache refresh for non-Hide)', async () => {
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce(null);
    mockDbWrite.modelEngagement.create.mockRejectedValueOnce(p2002(['userId', 'modelId']));

    const result = await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Notify' });

    expect(result).toBe(true);
    expect(refreshCache).not.toHaveBeenCalled();
  });

  it('happy path (no race): creates, returns true, refreshes cache for Hide', async () => {
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce(null);
    mockDbWrite.modelEngagement.create.mockResolvedValueOnce({});

    const result = await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Hide' });

    expect(result).toBe(true);
    expect(mockDbWrite.modelEngagement.create).toHaveBeenCalledTimes(1);
    expect(refreshCache).toHaveBeenCalledWith({ userId: 42 });
  });

  it('rethrows a non-P2002 create error (does not swallow real failures)', async () => {
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce(null);
    mockDbWrite.modelEngagement.create.mockRejectedValueOnce(new Error('connection reset'));

    await expect(toggleModelEngagement({ userId: 42, modelId: 10, type: 'Hide' })).rejects.toThrow(
      'connection reset'
    );
    // The side-effect must NOT run when the create genuinely failed.
    expect(refreshCache).not.toHaveBeenCalled();
  });
});

describe('toggleModelEngagement — explicit setTo direction (notify silent-unsubscribe fix)', () => {
  // Regression for the audit finding on the engaged-models client refactor:
  // a genuinely Notify-ON model whose by-ids read errored made the client render
  // the bell as "off"; the old notify mutation then sent `type=undefined` → the
  // server BLIND-toggled (`setTo ??= engagement?.type===type ? false : true`) and,
  // seeing the existing Notify row, DELETED it — a silent, wrong-direction
  // unsubscribe. The fix makes the client always carry an explicit `setTo`, so the
  // server sets the row to exactly the intended state and can never delete on a
  // "subscribe" click. These tests pin BOTH: the old blind path was destructive,
  // the new explicit-setTo path is an idempotent subscribe.

  it('LEGACY blind toggle (no setTo) on an existing Notify → DELETES it (the bug being closed)', async () => {
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce({ type: 'Notify' });

    const result = await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Notify' });

    // Blind toggle: existing type === requested type → setTo resolves to false → delete.
    // Scoped to the type being removed, so an un-notify cannot take a Favorite or a
    // Hide that arrived after the read: assert the FILTER, not that a delete happened.
    expect(mockDbWrite.modelEngagement.deleteMany).toHaveBeenCalledWith({
      where: { userId: 42, modelId: 10, type: 'Notify' },
    });
    expect(result).toBe(false); // "unsubscribed" — exactly the silent-unsubscribe symptom
  });

  it('explicit setTo:true on an existing Notify → NO delete, idempotent subscribe (returns true)', async () => {
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce({ type: 'Notify' });

    const result = await toggleModelEngagement({
      userId: 42,
      modelId: 10,
      type: 'Notify',
      setTo: true,
    });

    // The row already IS Notify and we asked to set it ON → no-op success, never a delete.
    expect(mockDbWrite.modelEngagement.deleteMany).not.toHaveBeenCalled();
    expect(mockDbWrite.modelEngagement.updateMany).not.toHaveBeenCalled();
    expect(result).toBe(true); // still subscribed
  });

  it('explicit setTo:true on a Mute row (type Notify) → UPDATEs to Notify (un-mute subscribe), never deletes', async () => {
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce({ type: 'Mute' });

    const result = await toggleModelEngagement({
      userId: 42,
      modelId: 10,
      type: 'Notify',
      setTo: true,
    });

    // The `type: 'Mute'` filter is the whole protection — an unscoped updateMany
    // passes a bare "was it called" check and still converts a row another writer
    // established between the read and here.
    expect(mockDbWrite.modelEngagement.updateMany).toHaveBeenCalledWith({
      where: { userId: 42, modelId: 10, type: 'Mute' },
      data: { type: 'Notify', createdAt: expect.any(Date) },
    });
    expect(mockDbWrite.modelEngagement.deleteMany).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('explicit setTo:true type Mute on an existing Notify → UPDATEs to Mute (turn-off), never blind-deletes', async () => {
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce({ type: 'Notify' });

    const result = await toggleModelEngagement({
      userId: 42,
      modelId: 10,
      type: 'Mute',
      setTo: true,
    });

    expect(mockDbWrite.modelEngagement.updateMany).toHaveBeenCalledWith({
      where: { userId: 42, modelId: 10, type: 'Notify' },
      data: { type: 'Mute', createdAt: expect.any(Date) },
    });
    expect(mockDbWrite.modelEngagement.deleteMany).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  // 868kurkc7. `ModelEngagement` is one row per (user, model) carrying one of
  // Favorite | Hide | Mute | Notify. A PK-addressed write lands on whatever occupies
  // the row — including a type a sibling writer established a millisecond ago — and
  // reports success. A race cannot be scheduled from a test, but "no writer is
  // capable of it" can be asserted.
  it.each(['Favorite', 'Hide', 'Mute', 'Notify'] as const)(
    'issues no PK-addressed write over a %s row',
    async (type) => {
      mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce({ type });

      await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Hide', setTo: true });

      expect([
        ...mockDbWrite.modelEngagement.delete.mock.calls,
        ...mockDbWrite.modelEngagement.update.mock.calls,
      ]).toEqual([]);
    }
  );

  it('reports NO engagement when a concurrent writer replaced the row it read', async () => {
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce({ type: 'Mute' });
    // The scoped update matches nothing: the pair holds something other than the Mute
    // this call saw, so it does not hold Notify either. Returning true here is the
    // 868kumcfc shape — a claim the caller fires tracking and rewards on.
    mockDbWrite.modelEngagement.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await toggleModelEngagement({
      userId: 42,
      modelId: 10,
      type: 'Notify',
      setTo: true,
    });

    expect(result).toBe(false);
  });

  it('refreshes HiddenModels when a conversion changes the hidden set, in EITHER direction', async () => {
    // `HiddenModels` is keyed on `type = 'Hide'`, and nothing refreshed it on this
    // branch before: converting a Hide to Notify left the model filtered out of the
    // user's feed until the whole per-user hash aged out.
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce({ type: 'Hide' });

    await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Notify', setTo: true });

    expect(refreshCache).toHaveBeenCalledWith({ userId: 42 });
  });

  it('does NOT refresh HiddenModels when the conversion matched no row', async () => {
    // The `count &&` guard. Without it a lost race still drops the user's per-user
    // hash field, on a conversion that did not happen.
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce({ type: 'Hide' });
    mockDbWrite.modelEngagement.updateMany.mockResolvedValueOnce({ count: 0 });

    await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Notify', setTo: true });

    expect(refreshCache).not.toHaveBeenCalled();
  });

  it('does NOT refresh HiddenModels for a conversion that leaves the hidden set alone', async () => {
    // Control for the test above: refreshing unconditionally would pass it while
    // dropping a per-user hash field on every unrelated Favorite/Mute/Notify click.
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce({ type: 'Mute' });

    await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Notify', setTo: true });

    expect(refreshCache).not.toHaveBeenCalled();
  });

  it('explicit setTo:true with no existing row → CREATEs the requested type (fresh subscribe)', async () => {
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce(null);

    const result = await toggleModelEngagement({
      userId: 42,
      modelId: 10,
      type: 'Notify',
      setTo: true,
    });

    expect(mockDbWrite.modelEngagement.create).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.modelEngagement.delete).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });
});

describe('toggleUserBountyEngagement — idempotent on P2002 race (sibling)', () => {
  it('P2002 on create → returns true instead of 500', async () => {
    mockDbRead.bountyEngagement.findUnique.mockResolvedValueOnce(null);
    mockDbWrite.bountyEngagement.create.mockRejectedValueOnce(
      p2002(['type', 'bountyId', 'userId'])
    );

    const result = await toggleUserBountyEngagement({
      userId: 42,
      bountyId: 5,
      type: 'Favorite' as never,
    });

    expect(result).toBe(true);
  });

  it('rethrows a non-P2002 create error', async () => {
    mockDbRead.bountyEngagement.findUnique.mockResolvedValueOnce(null);
    mockDbWrite.bountyEngagement.create.mockRejectedValueOnce(new Error('boom'));

    await expect(
      toggleUserBountyEngagement({ userId: 42, bountyId: 5, type: 'Favorite' as never })
    ).rejects.toThrow('boom');
  });
});

/**
 * The update branch (`setTo && engagement.type !== type`) converts a row in place and
 * was the only branch that never refreshed the hidden-models cache. Both directions
 * change hidden-ness, and the delete/create branches' `type === 'Hide'` test only sees
 * the NEW type — so copying it here would have fixed one direction and left the other.
 *
 * Reachable from the live `user.toggleNotifyModel`: `toggleModelEngagementInput`
 * declares `type` as the full `ModelEngagementType` enum, Hide included, plus `setTo`.
 */
describe('toggleModelEngagement — the update branch refreshes the hidden-models cache', () => {
  it('Notify -> Hide refreshes it, or the model keeps showing in the feed', async () => {
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce({ type: 'Notify' });

    const result = await toggleModelEngagement({
      userId: 42,
      modelId: 10,
      type: 'Hide',
      setTo: true,
    });

    expect(mockDbWrite.modelEngagement.update).toHaveBeenCalledTimes(1);
    expect(refreshCache).toHaveBeenCalledWith({ userId: 42 });
    expect(result).toBe(true);
  });

  it('Hide -> Notify refreshes it, or the model stays filtered out', async () => {
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce({ type: 'Hide' });

    const result = await toggleModelEngagement({
      userId: 42,
      modelId: 10,
      type: 'Notify',
      setTo: true,
    });

    expect(mockDbWrite.modelEngagement.update).toHaveBeenCalledTimes(1);
    // The new type is not Hide — only the OLD one is, which is why the guard has to
    // read both sides.
    expect(refreshCache).toHaveBeenCalledWith({ userId: 42 });
    expect(result).toBe(true);
  });

  // Negative control: refreshing unconditionally would pass both cases above and
  // spend a Redis round-trip on every favourite/notify conversion.
  it('Favorite -> Notify does NOT refresh it — neither side is Hide', async () => {
    mockDbWrite.modelEngagement.findUnique.mockResolvedValueOnce({ type: 'Favorite' });

    await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Notify', setTo: true });

    expect(mockDbWrite.modelEngagement.update).toHaveBeenCalledTimes(1);
    expect(refreshCache).not.toHaveBeenCalled();
  });
});
