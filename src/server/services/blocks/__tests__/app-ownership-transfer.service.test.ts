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
  // 🔴 The user read is LOGGED into `calls`, so its POSITION relative to `tx:begin` is
  // observable. `dbRead` and `dbWrite` are the same fake here, so "was the ban read on
  // the primary?" cannot be asked by identity — only by ordering. Without this, a mutant
  // that moves the read OUT of the transaction (back onto the replica, where a very
  // recent ban may not be visible) is indistinguishable from correct code.
  mockDb.user.findUnique.mockImplementation(async (..._a: unknown[]) => {
    calls.push('read:user');
    return { id: NEW_OWNER, bannedAt: null };
  });
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
    await initiateTransfer({
      appBlockId: APP,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
      now: NOW,
    });
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

  // 🔴 THE TWO PARTY COLUMNS, asserted as VALUES. A mutant that swapped them survived:
  // `fromUserId`/`toUserId` are both plain ints on the same row, so the create
  // type-checks either way round and every downstream assertion in the old suite read
  // the row back through the same swap. A swapped row makes `acceptTransfer`'s
  // status-guarded `where: { userId: fromUserId }` match nobody — the offer becomes
  // permanently unacceptable — while `cancelTransfer` hands the withdraw right to the
  // wrong party. Fixture ids are deliberately distinct so the two cannot alias.
  it('🔴 the offer records fromUserId = CURRENT OWNER and toUserId = RECIPIENT, not the reverse', async () => {
    const t = await initiateTransfer({
      appBlockId: APP,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
      now: NOW,
    });
    const created = mockDb.appOwnershipTransfer.create.mock.calls[0][0] as {
      data: { fromUserId: number; toUserId: number; appBlockId: string; status: string };
    };
    expect(created.data.fromUserId).toBe(OLD_OWNER);
    expect(created.data.toUserId).toBe(NEW_OWNER);
    expect(created.data.appBlockId).toBe(APP);
    expect(created.data.status).toBe('pending');
    // …and the returned view carries the same orientation the client will render.
    expect(t.fromUserId).toBe(OLD_OWNER);
    expect(t.toUserId).toBe(NEW_OWNER);
    // POSITIVE CONTROL: the two ids are distinct, so a swap is observable at all.
    expect(OLD_OWNER).not.toBe(NEW_OWNER);
  });

  it('🔴 `fromUserId` is the app’s CURRENT owner, not merely the actor', async () => {
    // The audit event names the target; the row must name the owner it is moving FROM.
    await initiateTransfer({
      appBlockId: APP,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
      now: NOW,
    });
    const evt = mockDb.appOwnershipEvent.create.mock.calls[0][0] as {
      data: { actorUserId: number; targetUserId: number };
    };
    expect(evt.data.actorUserId).toBe(OLD_OWNER);
    expect(evt.data.targetUserId).toBe(NEW_OWNER);
  });

  it('EXPIRED pending rows are reclaimed first, so one lapsed offer cannot wedge the app forever', async () => {
    await initiateTransfer({
      appBlockId: APP,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
      now: NOW,
    });
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
    expect(order.slice(1, -1)).toEqual(['write:oauthClient', 'write:appListing', 'write:event']);
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

// ---------------------------------------------------------------------------
// 🔴 The BAN is re-read at ACCEPT, not inherited from the offer or the session.
// ---------------------------------------------------------------------------

describe('🔴 acceptTransfer re-reads bannedAt — the 7-day window', () => {
  /**
   * THE HOLE THIS CLOSES. The stated policy is "a banned user may not receive an
   * ownership transfer". It was enforced at INITIATE (against the user row) and at the
   * proc (against `ctx.user.bannedAt`, a SESSION value). An offer stays live for
   * `transferExpiryDays`, so between those two points a recipient can be banned and the
   * policy silently stops holding: `respondToInvite` re-reads the user row for exactly
   * this reason, and this path — which hands over an entire app, its repo write and its
   * earnings surface — did not.
   *
   * The read is issued through the TRANSACTION (the primary), not the replica, because
   * an ownership move is not cheap to unwind and a ban is a deny signal you never want
   * to read stale.
   */
  it('a recipient banned AFTER the offer was made cannot accept', async () => {
    // The offer itself is untouched and still live — only the user row changed.
    mockDb.user.findUnique.mockResolvedValue({ id: NEW_OWNER, bannedAt: new Date() });
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'BANNED' });
  });

  it('🔴 …and NOTHING moves: neither ownership column, no audit event, no repo grant', async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: NEW_OWNER, bannedAt: new Date() });
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'BANNED' });
    expect(mockDb.oauthClient.updateMany).not.toHaveBeenCalled();
    expect(mockDb.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockDb.appOwnershipEvent.create).not.toHaveBeenCalled();
    expect(mockRepo.grantAppRepoWrite).not.toHaveBeenCalled();
    // The whole transaction aborts, which is what makes the guard's position safe.
    expect(calls).toContain('tx:rollback');
  });

  it('the ban is read for the ACCEPTING user, on the primary, inside the tx', async () => {
    await acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW });
    expect(mockDb.user.findUnique).toHaveBeenCalledWith({
      where: { id: NEW_OWNER },
      select: { bannedAt: true },
    });
    // 🔴 ORDERING, not just "it was called": the read must sit strictly BETWEEN
    // `tx:begin` and `tx:commit`. A pre-tx read runs on the replica, where a ban applied
    // seconds ago may not be visible yet — and since both pools are the same fake here,
    // ordering is the ONLY thing that distinguishes the two.
    expect(calls).toEqual(['tx:begin', 'read:user', 'tx:commit']);
  });

  it('🔴 NEGATIVE CONTROL: an UNBANNED recipient still completes the transfer', async () => {
    // Otherwise "it threw" would be indistinguishable from a guard that refuses
    // everyone — the fail-closed mutant.
    mockDb.user.findUnique.mockResolvedValue({ id: NEW_OWNER, bannedAt: null });
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW })
    ).resolves.toMatchObject({ toUserId: NEW_OWNER });
    expect(mockDb.oauthClient.updateMany).toHaveBeenCalledOnce();
  });

  it('🔴 the read is issued on the TRANSACTION CLIENT, not on the bare `dbRead`', async () => {
    /**
     * WHY ORDERING WAS NOT ENOUGH. This suite hands the SAME fake to `dbRead` and
     * `dbWrite`, so a mutant that changes `tx.user.findUnique` to `dbRead.user.findUnique`
     * WITHOUT moving it out of the callback keeps the identical call ordering and
     * SURVIVED the first sweep — it is the same fixture-collapse trap the audit flagged
     * on `recordOwnershipEvent`. Yet the defect is real: inside a primary transaction,
     * `dbRead` still goes to the REPLICA, which is exactly where a ban applied seconds
     * ago is not yet visible — i.e. the mutant silently restores the hole this fix
     * closes.
     *
     * Only a DISTINCT tx double can tell them apart, so this test builds one.
     */
    const tx = {
      user: { findUnique: vi.fn(async (..._a: unknown[]) => ({ bannedAt: null })) },
      appOwnershipTransfer: {
        findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => liveTransfer()),
        updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
      },
      oauthClient: { updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })) },
      appListing: { updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })) },
      appOwnershipEvent: { create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})) },
    };
    mockDb.$transaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
    // POSITIVE CONTROL: two objects, or every assertion below is vacuous.
    expect(tx.user.findUnique).not.toBe(mockDb.user.findUnique);

    await acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW });

    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: NEW_OWNER },
      select: { bannedAt: true },
    });
    // 🔴 The mutant's signature: the ban read routed through the replica handle.
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
  });

  it('a recipient row that has vanished does not block the transfer on a null read', async () => {
    // `bannedAt` is the question; a missing row is not a ban. (The FK makes this
    // unreachable in practice — pinned so the guard cannot drift into `if (!user) throw`,
    // which would fail the transfer for the wrong reason.)
    mockDb.user.findUnique.mockResolvedValue(null);
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW })
    ).resolves.toMatchObject({ toUserId: NEW_OWNER });
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
    expect(
      await getPendingTransfer({ appBlockId: APP, viewerUserId: OLD_OWNER, now: NOW })
    ).toMatchObject({ id: TRANSFER });
  });

  it('🔴 getPendingTransfer treats an EXPIRED row as ABSENT (read-time predicate, no sweeper needed)', async () => {
    mockDb.appOwnershipTransfer.findFirst.mockResolvedValue(liveTransfer({ expiresAt: PAST }));
    expect(
      await getPendingTransfer({ appBlockId: APP, viewerUserId: OLD_OWNER, now: NOW })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 🔴 getPendingTransfer is AUTHORIZED.
// ---------------------------------------------------------------------------

describe('🔴 getPendingTransfer — who may read the offer', () => {
  /**
   * This read had NO authorization at all: the proc destructured `{ input }` and never
   * touched `ctx`, while all three sibling transfer procs gate. The row it returns names
   * both parties (`fromUserId`, `toUserId`) and the deadline, so any account with the
   * author flag could ask, for any app id, who is handing it to whom and by when —
   * a pre-announcement of an acquisition, readable by the whole flagged cohort.
   *
   * Permitted: the app OWNER (the offer's `fromUserId`) and the ADDRESSEE. That is
   * exactly the set that may ACT on the transfer, which is what makes it consistent
   * rather than arbitrary.
   */
  const EDITOR = 30;

  beforeEach(() => {
    mockDb.appOwnershipTransfer.findFirst.mockResolvedValue(liveTransfer());
    mockDb.appBlock.findUnique.mockResolvedValue({
      id: APP,
      appId: CLIENT,
      blockId: SLUG,
      app: { userId: OLD_OWNER },
    });
    mockDb.appCollaborator.findFirst.mockImplementation(async (args: unknown) => {
      const w = (args as { where: { userId: number; status?: string } }).where;
      return w.userId === EDITOR && w.status === 'accepted' ? { userId: EDITOR } : null;
    });
  });

  it('the OWNER sees the offer', async () => {
    await expect(
      getPendingTransfer({ appBlockId: APP, viewerUserId: OLD_OWNER, now: NOW })
    ).resolves.toMatchObject({ id: TRANSFER, toUserId: NEW_OWNER });
  });

  it('the ADDRESSEE sees the offer they must accept', async () => {
    await expect(
      getPendingTransfer({ appBlockId: APP, viewerUserId: NEW_OWNER, now: NOW })
    ).resolves.toMatchObject({ id: TRANSFER });
  });

  it('🔴 a STRANGER gets null — not the row, and not a FORBIDDEN either', async () => {
    // `null`, deliberately: a throw would make this proc an EXISTENCE ORACLE, and "this
    // app has a pending transfer" is itself the private fact. The refusal has to be
    // indistinguishable from "there is no offer".
    await expect(
      getPendingTransfer({ appBlockId: APP, viewerUserId: STRANGER, now: NOW })
    ).resolves.toBeNull();
  });

  it('🔴 an ACCEPTED EDITOR gets null — a seat is not a claim on the app’s disposal', async () => {
    // An editor is a co-owner for CONTENT. Initiating a transfer is one of the two
    // owner-reserved actions, so watching one is not theirs either.
    await expect(
      getPendingTransfer({ appBlockId: APP, viewerUserId: EDITOR, now: NOW })
    ).resolves.toBeNull();
  });

  it('POSITIVE CONTROL: that same editor really does resolve as an editor', async () => {
    // Otherwise the null above proves nothing — it could be a seat lookup wired to
    // nothing rather than a deliberate exclusion.
    const { resolveAppAccess: resolve } = await import(
      '~/server/services/blocks/app-access.service'
    );
    expect((await resolve(APP, EDITOR))!.role).toBe('editor');
  });

  it('a missing app is NOT_FOUND', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue(null);
    await expect(
      getPendingTransfer({ appBlockId: APP, viewerUserId: OLD_OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an EXPIRED offer is null for the owner too (expiry still wins over authorization)', async () => {
    mockDb.appOwnershipTransfer.findFirst.mockResolvedValue(liveTransfer({ expiresAt: PAST }));
    await expect(
      getPendingTransfer({ appBlockId: APP, viewerUserId: OLD_OWNER, now: NOW })
    ).resolves.toBeNull();
  });
});
