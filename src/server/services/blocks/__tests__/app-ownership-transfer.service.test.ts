import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Listing COLLABORATORS — OWNERSHIP TRANSFER.
 *
 * The load-bearing properties, each with its own describe:
 *   - ATOMICITY: both ownership columns move together; a failure on the SECOND write
 *     rolls the FIRST back.
 *   - A PENDING transfer confers NOTHING.
 *   - MONEY INVARIANCE: `BlockBuzzAttribution` is never touched, so payout grouping by
 *     `(app_owner_user_id, period_key)` cannot collide and the old owner keeps their
 *     accrual.
 *   - Submission history is preserved.
 *   - EXPIRY and cancellation.
 *
 * 🔴 The `$transaction` fake runs the callback inline against the SAME mock, so it
 * cannot itself roll anything back. The atomicity test therefore asserts what a real
 * rollback GUARANTEES and what this fake CAN observe: that the throw propagates out of
 * `$transaction` (so the real client aborts), and that every write the service performs
 * is issued INSIDE that callback rather than before it. A write issued outside the
 * transaction would survive a rollback, and that is precisely the defect being
 * excluded — see the `writes are all inside the tx` test, which is the structural half.
 */

const { mockDb, mockRepo, mockNotify, calls } = vi.hoisted(() => {
  const calls: string[] = [];
  const db = {
    appBlock: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    user: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    oauthClient: { updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })) },
    appListing: { updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })) },
    appOwnershipTransfer: {
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
    appOwnershipEvent: { create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})) },
    // 🔴 Present but NEVER expected to be called. Its absence from the call log is the
    // money-invariance assertion.
    blockBuzzAttribution: {
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
      update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
    },
    appBlockPublishRequest: { updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })) },
    appCollaborator: {
      deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (cb: (tx: typeof db) => Promise<unknown>) => {
    calls.push('tx:begin');
    try {
      const r = await cb(db);
      calls.push('tx:commit');
      return r;
    } catch (e) {
      calls.push('tx:rollback');
      throw e;
    }
  });
  return {
    mockDb: db,
    mockRepo: {
      grantAppRepoWrite: vi.fn(async () => undefined),
      revokeAppRepoWrite: vi.fn(async () => undefined),
    },
    mockNotify: { notifyAppCollaborator: vi.fn(async () => undefined) },
    calls,
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/services/blocks/app-repo-access', () => mockRepo);
vi.mock('~/server/services/blocks/app-collaborator-notify', () => mockNotify);

const { acceptTransfer, cancelTransfer, getPendingTransfer, initiateTransfer } = await import(
  '~/server/services/blocks/app-ownership-transfer.service'
);
const { resolveAppAccess } = await import('~/server/services/blocks/app-access.service');

const APP = 'ab_app1';
const CLIENT = 'oc_client1';
const SLUG = 'my-app';
const OLD_OWNER = 10;
const NEW_OWNER = 20;
const STRANGER = 50;
const TRANSFER = 'aot_t1';
const NOW = new Date('2026-08-10T12:00:00Z');
const FUTURE = new Date('2026-08-17T12:00:00Z');
const PAST = new Date('2026-08-03T12:00:00Z');

function liveTransfer(over: Record<string, unknown> = {}) {
  return {
    id: TRANSFER,
    appBlockId: APP,
    fromUserId: OLD_OWNER,
    toUserId: NEW_OWNER,
    status: 'pending',
    expiresAt: FUTURE,
    createdAt: NOW,
    appBlock: { appId: CLIENT, blockId: SLUG },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mockDb.$transaction.mockImplementation(async (cb: (tx: typeof mockDb) => Promise<unknown>) => {
    calls.push('tx:begin');
    try {
      const r = await cb(mockDb);
      calls.push('tx:commit');
      return r;
    } catch (e) {
      calls.push('tx:rollback');
      throw e;
    }
  });
  mockDb.appBlock.findUnique.mockResolvedValue({
    id: APP,
    appId: CLIENT,
    blockId: SLUG,
    app: { userId: OLD_OWNER },
  });
  mockDb.user.findUnique.mockResolvedValue({ id: NEW_OWNER, bannedAt: null });
  mockDb.oauthClient.updateMany.mockResolvedValue({ count: 1 });
  mockDb.appListing.updateMany.mockResolvedValue({ count: 1 });
  mockDb.appOwnershipTransfer.updateMany.mockResolvedValue({ count: 1 });
  mockDb.appOwnershipTransfer.findUnique.mockResolvedValue(liveTransfer());
  mockDb.appOwnershipTransfer.create.mockImplementation(async (args: unknown) => ({
    ...(args as { data: Record<string, unknown> }).data,
    createdAt: NOW,
  }));
});

describe('initiateTransfer', () => {
  it('the OWNER can offer; the row is pending with an expiry and an event is written', async () => {
    const t = await initiateTransfer({
      appBlockId: APP,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
      now: NOW,
    });
    expect(t.status).toBe('pending');
    expect(t.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    const evt = mockDb.appOwnershipEvent.create.mock.calls[0][0] as { data: { action: string } };
    expect(evt.data.action).toBe('transfer_initiated');
    expect(mockNotify.notifyAppCollaborator).toHaveBeenCalledOnce();
  });

  it('🔴 NOTHING moves at initiate — neither ownership column is written', async () => {
    await initiateTransfer({ appBlockId: APP, toUserId: NEW_OWNER, actorUserId: OLD_OWNER, now: NOW });
    expect(mockDb.oauthClient.updateMany).not.toHaveBeenCalled();
    expect(mockDb.appListing.updateMany).not.toHaveBeenCalled();
  });

  it('a NON-OWNER cannot initiate', async () => {
    await expect(
      initiateTransfer({ appBlockId: APP, toUserId: NEW_OWNER, actorUserId: STRANGER, now: NOW })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
  });

  it('transferring to yourself is INVALID_TARGET', async () => {
    await expect(
      initiateTransfer({ appBlockId: APP, toUserId: OLD_OWNER, actorUserId: OLD_OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('🔴 a BANNED recipient cannot receive ownership', async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: NEW_OWNER, bannedAt: new Date() });
    await expect(
      initiateTransfer({ appBlockId: APP, toUserId: NEW_OWNER, actorUserId: OLD_OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'BANNED' });
  });

  it('EXPIRED pending rows are reclaimed first, so one lapsed offer cannot wedge the app forever', async () => {
    await initiateTransfer({ appBlockId: APP, toUserId: NEW_OWNER, actorUserId: OLD_OWNER, now: NOW });
    const reclaim = mockDb.appOwnershipTransfer.updateMany.mock.calls[0][0] as {
      where: { status: string; expiresAt: { lte: Date } };
      data: { status: string };
    };
    expect(reclaim.where.status).toBe('pending');
    expect(reclaim.where.expiresAt.lte).toEqual(NOW);
    expect(reclaim.data.status).toBe('expired');
  });

  it('a concurrent second offer loses on the partial-unique index (P2002) with a friendly error', async () => {
    mockDb.appOwnershipTransfer.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    );
    await expect(
      initiateTransfer({ appBlockId: APP, toUserId: NEW_OWNER, actorUserId: OLD_OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'ALREADY_SEATED' });
  });

  it('🔴 NEGATIVE CONTROL: a non-P2002 error is NOT swallowed as "already pending"', async () => {
    // A broad catch here would mask genuine write failures as a benign conflict.
    mockDb.appOwnershipTransfer.create.mockRejectedValue(
      Object.assign(new Error('connection reset'), { code: 'P1001' })
    );
    await expect(
      initiateTransfer({ appBlockId: APP, toUserId: NEW_OWNER, actorUserId: OLD_OWNER, now: NOW })
    ).rejects.toThrow('connection reset');
  });
});

describe('a PENDING transfer confers NOTHING on the recipient', () => {
  it('resolveAppAccess gives the recipient no role while the offer is open', async () => {
    // The access predicate does not consult the transfer table at all — asserted by
    // observing the resolved role, which is the property that matters.
    mockDb.appBlock.findUnique.mockResolvedValue({ id: APP, app: { userId: OLD_OWNER } });
    // No SEAT exists for the recipient — the open offer is the only thing linking them
    // to the app, and it must count for nothing.
    mockDb.appCollaborator.findFirst.mockResolvedValue(null);
    const access = await resolveAppAccess(APP, NEW_OWNER);
    expect(access!.role).toBeNull();
    expect(access!.ownerUserId).toBe(OLD_OWNER);
  });
});

describe('acceptTransfer — 🔴 ATOMICITY of the two ownership columns', () => {
  it('moves BOTH OauthClient.userId and AppListing.userId', async () => {
    const res = await acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW });
    expect(res).toMatchObject({ fromUserId: OLD_OWNER, toUserId: NEW_OWNER });

    const client = mockDb.oauthClient.updateMany.mock.calls[0][0] as {
      where: { id: string; userId: number };
      data: { userId: number };
    };
    expect(client.where).toEqual({ id: CLIENT, userId: OLD_OWNER });
    expect(client.data.userId).toBe(NEW_OWNER);

    const listing = mockDb.appListing.updateMany.mock.calls[0][0] as {
      where: { appBlockId: string };
      data: { userId: number };
    };
    expect(listing.where.appBlockId).toBe(APP);
    expect(listing.data.userId).toBe(NEW_OWNER);
  });

  it('🔴 a failure on the SECOND write aborts the transaction (the first cannot commit alone)', async () => {
    mockDb.appListing.updateMany.mockRejectedValue(new Error('listing write exploded'));
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW })
    ).rejects.toThrow('listing write exploded');
    // The throw must escape `$transaction` — that is what makes the real client roll
    // the first write back.
    expect(calls).toContain('tx:rollback');
    expect(calls).not.toContain('tx:commit');
    // …and no audit event is left behind by a transfer that did not happen.
    expect(mockDb.appOwnershipEvent.create).not.toHaveBeenCalled();
    // …nor any post-commit external effect.
    expect(mockRepo.revokeAppRepoWrite).not.toHaveBeenCalled();
    expect(mockRepo.grantAppRepoWrite).not.toHaveBeenCalled();
  });

  it('🔴 STRUCTURAL: every ownership write is issued INSIDE the transaction', async () => {
    // A write issued before `$transaction` would survive a rollback, which the inline
    // fake above cannot detect by outcome. Assert the ordering instead.
    const order: string[] = [];
    mockDb.$transaction.mockImplementation(async (cb: (tx: typeof mockDb) => Promise<unknown>) => {
      order.push('tx:begin');
      const r = await cb(mockDb);
      order.push('tx:end');
      return r;
    });
    mockDb.oauthClient.updateMany.mockImplementation(async () => {
      order.push('write:oauthClient');
      return { count: 1 };
    });
    mockDb.appListing.updateMany.mockImplementation(async () => {
      order.push('write:appListing');
      return { count: 1 };
    });
    mockDb.appOwnershipEvent.create.mockImplementation(async () => {
      order.push('write:event');
      return {};
    });
    await acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW });
    expect(order[0]).toBe('tx:begin');
    expect(order[order.length - 1]).toBe('tx:end');
    expect(order.slice(1, -1)).toEqual([
      'write:oauthClient',
      'write:appListing',
      'write:event',
    ]);
  });

  it('🔴 the client write is STATUS-GUARDED on the previous owner — a 0-count aborts', async () => {
    // Ownership changed since the offer (a second transfer landed first).
    mockDb.oauthClient.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'NO_INVITE' });
    expect(mockDb.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockDb.appOwnershipEvent.create).not.toHaveBeenCalled();
  });

  it('an app with NO listing yet still transfers (a 0-count on the listing is legitimate)', async () => {
    // A first-version app pending approval has no AppListing row; that must not fail
    // the transfer, which is why the listing write is deliberately NOT status-guarded.
    mockDb.appListing.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW })
    ).resolves.toMatchObject({ toUserId: NEW_OWNER });
  });

  it('only the ADDRESSEE can accept', async () => {
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: STRANGER, now: NOW })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
    expect(mockDb.oauthClient.updateMany).not.toHaveBeenCalled();
  });

  it('🔴 an EXPIRED offer cannot be accepted', async () => {
    mockDb.appOwnershipTransfer.findUnique.mockResolvedValue(liveTransfer({ expiresAt: PAST }));
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'NO_INVITE' });
    expect(mockDb.oauthClient.updateMany).not.toHaveBeenCalled();
  });

  it('a CANCELLED offer cannot be accepted', async () => {
    mockDb.appOwnershipTransfer.findUnique.mockResolvedValue(liveTransfer({ status: 'cancelled' }));
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'NO_INVITE' });
  });

  it('swaps the Forgejo grants post-commit: OLD owner revoked, NEW owner granted', async () => {
    await acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW });
    expect(mockRepo.revokeAppRepoWrite).toHaveBeenCalledWith({ slug: SLUG, userId: OLD_OWNER });
    expect(mockRepo.grantAppRepoWrite).toHaveBeenCalledWith({ slug: SLUG, userId: NEW_OWNER });
  });
});

describe('🔴 MONEY INVARIANCE — attribution and payout grouping are untouched', () => {
  it('accept never writes BlockBuzzAttribution', async () => {
    await acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW });
    // Rewriting `appOwnerUserId` mid-period would merge two owners' pending rows into
    // ONE payout group and can collide on the (app_owner_user_id, period_key) UNIQUE.
    // The old owner also stops being paid for what they already accrued.
    expect(mockDb.blockBuzzAttribution.updateMany).not.toHaveBeenCalled();
    expect(mockDb.blockBuzzAttribution.update).not.toHaveBeenCalled();
  });

  it('accept never rewrites submission history (AppBlockPublishRequest.submittedByUserId)', async () => {
    await acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW });
    expect(mockDb.appBlockPublishRequest.updateMany).not.toHaveBeenCalled();
  });

  it('accept never removes collaborator seats — the app keeps its editors', async () => {
    await acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW });
    expect(mockDb.appCollaborator.deleteMany).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: those mocks CAN record a call', async () => {
    // Otherwise the three "not called" assertions above are indistinguishable from
    // mocks wired to nothing.
    await mockDb.blockBuzzAttribution.updateMany({ where: {}, data: {} });
    await mockDb.appBlockPublishRequest.updateMany({ where: {}, data: {} });
    await mockDb.appCollaborator.deleteMany({ where: {} });
    expect(mockDb.blockBuzzAttribution.updateMany).toHaveBeenCalledOnce();
    expect(mockDb.appBlockPublishRequest.updateMany).toHaveBeenCalledOnce();
    expect(mockDb.appCollaborator.deleteMany).toHaveBeenCalledOnce();
  });
});

describe('cancelTransfer / getPendingTransfer', () => {
  it('the OWNER can withdraw the offer', async () => {
    const res = await cancelTransfer({ transferId: TRANSFER, actorUserId: OLD_OWNER, now: NOW });
    expect(res.cancelled).toBe(true);
    const evt = mockDb.appOwnershipEvent.create.mock.calls[0][0] as { data: { action: string } };
    expect(evt.data.action).toBe('transfer_cancelled');
  });

  it('the RECIPIENT can decline', async () => {
    await expect(
      cancelTransfer({ transferId: TRANSFER, actorUserId: NEW_OWNER, now: NOW })
    ).resolves.toMatchObject({ cancelled: true });
  });

  it('a third party cannot cancel', async () => {
    await expect(
      cancelTransfer({ transferId: TRANSFER, actorUserId: STRANGER, now: NOW })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
  });

  it('cancelling an already-terminal transfer is a no-op, not an error', async () => {
    mockDb.appOwnershipTransfer.updateMany.mockResolvedValue({ count: 0 });
    const res = await cancelTransfer({ transferId: TRANSFER, actorUserId: OLD_OWNER, now: NOW });
    expect(res.cancelled).toBe(false);
    expect(mockDb.appOwnershipEvent.create).not.toHaveBeenCalled();
  });

  it('getPendingTransfer returns a LIVE offer', async () => {
    mockDb.appOwnershipTransfer.findFirst.mockResolvedValue(liveTransfer());
    expect(await getPendingTransfer({ appBlockId: APP, now: NOW })).toMatchObject({ id: TRANSFER });
  });

  it('🔴 getPendingTransfer treats an EXPIRED row as ABSENT (read-time predicate, no sweeper needed)', async () => {
    mockDb.appOwnershipTransfer.findFirst.mockResolvedValue(liveTransfer({ expiresAt: PAST }));
    expect(await getPendingTransfer({ appBlockId: APP, now: NOW })).toBeNull();
  });
});
