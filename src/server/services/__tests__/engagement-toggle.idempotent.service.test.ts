import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { mockDb, refreshCache } = vi.hoisted(() => ({
  mockDb: {
    modelEngagement: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      delete: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
    },
    bountyEngagement: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      delete: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
    },
  },
  refreshCache: vi.fn(async () => undefined),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
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
    mockDb.modelEngagement.findUnique.mockResolvedValueOnce(null);
    mockDb.modelEngagement.create.mockRejectedValueOnce(p2002(['userId', 'modelId']));

    const result = await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Hide' });

    expect(result).toBe(true);
    // The Hide success path's side-effect must still run on the idempotent path.
    expect(refreshCache).toHaveBeenCalledWith({ userId: 42 });
  });

  it('Notify: P2002 on create → returns true (no cache refresh for non-Hide)', async () => {
    mockDb.modelEngagement.findUnique.mockResolvedValueOnce(null);
    mockDb.modelEngagement.create.mockRejectedValueOnce(p2002(['userId', 'modelId']));

    const result = await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Notify' });

    expect(result).toBe(true);
    expect(refreshCache).not.toHaveBeenCalled();
  });

  it('happy path (no race): creates, returns true, refreshes cache for Hide', async () => {
    mockDb.modelEngagement.findUnique.mockResolvedValueOnce(null);
    mockDb.modelEngagement.create.mockResolvedValueOnce({});

    const result = await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Hide' });

    expect(result).toBe(true);
    expect(mockDb.modelEngagement.create).toHaveBeenCalledTimes(1);
    expect(refreshCache).toHaveBeenCalledWith({ userId: 42 });
  });

  it('rethrows a non-P2002 create error (does not swallow real failures)', async () => {
    mockDb.modelEngagement.findUnique.mockResolvedValueOnce(null);
    mockDb.modelEngagement.create.mockRejectedValueOnce(new Error('connection reset'));

    await expect(
      toggleModelEngagement({ userId: 42, modelId: 10, type: 'Hide' })
    ).rejects.toThrow('connection reset');
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
    mockDb.modelEngagement.findUnique.mockResolvedValueOnce({ type: 'Notify' });

    const result = await toggleModelEngagement({ userId: 42, modelId: 10, type: 'Notify' });

    // Blind toggle: existing type === requested type → setTo resolves to false → delete.
    expect(mockDb.modelEngagement.delete).toHaveBeenCalledTimes(1);
    expect(result).toBe(false); // "unsubscribed" — exactly the silent-unsubscribe symptom
  });

  it('explicit setTo:true on an existing Notify → NO delete, idempotent subscribe (returns true)', async () => {
    mockDb.modelEngagement.findUnique.mockResolvedValueOnce({ type: 'Notify' });

    const result = await toggleModelEngagement({
      userId: 42,
      modelId: 10,
      type: 'Notify',
      setTo: true,
    });

    // The row already IS Notify and we asked to set it ON → no-op success, never a delete.
    expect(mockDb.modelEngagement.delete).not.toHaveBeenCalled();
    expect(mockDb.modelEngagement.update).not.toHaveBeenCalled();
    expect(result).toBe(true); // still subscribed
  });

  it('explicit setTo:true on a Mute row (type Notify) → UPDATEs to Notify (un-mute subscribe), never deletes', async () => {
    mockDb.modelEngagement.findUnique.mockResolvedValueOnce({ type: 'Mute' });

    const result = await toggleModelEngagement({
      userId: 42,
      modelId: 10,
      type: 'Notify',
      setTo: true,
    });

    expect(mockDb.modelEngagement.update).toHaveBeenCalledTimes(1);
    expect(mockDb.modelEngagement.delete).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('explicit setTo:true type Mute on an existing Notify → UPDATEs to Mute (turn-off), never blind-deletes', async () => {
    mockDb.modelEngagement.findUnique.mockResolvedValueOnce({ type: 'Notify' });

    const result = await toggleModelEngagement({
      userId: 42,
      modelId: 10,
      type: 'Mute',
      setTo: true,
    });

    expect(mockDb.modelEngagement.update).toHaveBeenCalledTimes(1);
    expect(mockDb.modelEngagement.delete).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('explicit setTo:true with no existing row → CREATEs the requested type (fresh subscribe)', async () => {
    mockDb.modelEngagement.findUnique.mockResolvedValueOnce(null);

    const result = await toggleModelEngagement({
      userId: 42,
      modelId: 10,
      type: 'Notify',
      setTo: true,
    });

    expect(mockDb.modelEngagement.create).toHaveBeenCalledTimes(1);
    expect(mockDb.modelEngagement.delete).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });
});

describe('toggleUserBountyEngagement — idempotent on P2002 race (sibling)', () => {
  it('P2002 on create → returns true instead of 500', async () => {
    mockDb.bountyEngagement.findUnique.mockResolvedValueOnce(null);
    mockDb.bountyEngagement.create.mockRejectedValueOnce(
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
    mockDb.bountyEngagement.findUnique.mockResolvedValueOnce(null);
    mockDb.bountyEngagement.create.mockRejectedValueOnce(new Error('boom'));

    await expect(
      toggleUserBountyEngagement({ userId: 42, bountyId: 5, type: 'Favorite' as never })
    ).rejects.toThrow('boom');
  });
});
