import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Listing COLLABORATORS — OWNERSHIP TRANSFER.
 *
 * The load-bearing properties, each with its own describe:
 *   - ATOMICITY: on an ON-SITE listing both ownership columns move together; a failure
 *     on the SECOND write rolls the FIRST back.
 *   - KIND: an OFF-SITE listing moves `AppListing.userId` ONLY — and one carrying a
 *     `connectClientId` is REFUSED outright, at initiate AND again in-tx at accept.
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
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
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

const {
  acceptTransfer,
  cancelTransfer,
  getPendingTransfer,
  initiateTransfer,
  refusesTransferForConnectClient,
  CONNECT_CLIENT_TRANSFER_REFUSAL,
} = await import('~/server/services/blocks/app-ownership-transfer.service');
const { resolveListingAccess } = await import('~/server/services/blocks/app-access.service');

const APP = 'ab_app1';
const CLIENT = 'oc_client1';
const SLUG = 'my-app';
/** The ON-SITE listing: an AppBlock, an OauthClient, a Forgejo repo. */
const LISTING = 'apl_live';
/** A plain external-link OFF-SITE listing: no block, no client. Transferable. */
const OFFSITE = 'apl_offsite';
const OFFSITE_SLUG = 'cool-offsite';
/** An OAuth-CONNECT off-site listing. 🔴 NOT transferable in v1. */
const CONNECT_LISTING = 'apl_connect';
const CONNECT_CLIENT = 'oc_connect9';
const SHADOW = 'apl_shadow';
/**
 * 🔴 An OFF-SITE listing that DOES carry a backing AppBlock — and therefore a Forgejo
 * repo slug. `mapAppBlockToListing` mints exactly this shape for an AppBlock with an
 * `externalUrl`. It is the row on which `kind === 'onsite'` and `blockSlug != null`
 * DISAGREE, and `acceptTransfer` used to branch on each of them in different places:
 * step (2) on the kind, the post-commit Forgejo swap on the slug.
 */
const OFFSITE_WITH_REPO = 'apl_offsite_with_repo';
const OFFSITE_REPO_SLUG = 'offsite-repo';
/**
 * 🔴 An ON-SITE listing whose denormalized `AppListing.userId` DISAGREES with its
 * canonical `OauthClient.userId`.
 *
 * 🔴 Step (3) does NOT leave this behind on the row it writes, despite being unguarded
 * for onsite: `where: { id }` is unconditional, runs in the same tx as the step-(2)
 * `OauthClient` move, and follows an in-tx read of the same row through its own FK — so
 * it HEALS the copy. What it leaves behind is any SHADOW REVISION of that listing, which
 * it never addresses and which froze `userId` at clone time. This fixture is the
 * resulting state, whichever row you imagine it on. Full mechanism:
 * `app-access.denormalized-owner-drift.test.ts`.
 */
const DRIFTED = 'apl_drifted';
/**
 * 🔴 An OFF-SITE listing carrying a block whose `OauthClient` names SOMEONE ELSE —
 * issue #3844. For an off-site listing `AppListing.userId` IS the owner, and the accept
 * path's step (2) is `if (isOnsite)`-guarded, so an off-site move writes only that
 * column and leaves the attached block naming the PREVIOUS owner (as does the mod
 * `claimListing` remedy). `loadOwnedListing` resolved BLOCK-FIRST until #3844, so this
 * gate answered to the ex-owner: they could still INITIATE A TRANSFER of a listing they
 * no longer owned and hand it straight back out.
 */
const OFFSITE_BLOCK_DRIFTED = 'apl_offsite_block_drifted';
const OLD_OWNER = 10;
const NEW_OWNER = 20;
const STRANGER = 50;
/** The name left behind in a stale denormalized `AppListing.userId`. */
const STALE_OWNER = 77;
const TRANSFER = 'aot_t1';
const NOW = new Date('2026-08-10T12:00:00Z');
const FUTURE = new Date('2026-08-17T12:00:00Z');
const PAST = new Date('2026-08-03T12:00:00Z');

/**
 * The listing table, keyed by id. Every row differs from every other in id, slug, kind,
 * appBlockId AND connectClientId, so no assertion can be satisfied by the wrong row.
 */
function listingTable(): Record<string, Record<string, unknown>> {
  return {
    [LISTING]: {
      id: LISTING,
      slug: SLUG,
      kind: 'onsite',
      userId: OLD_OWNER,
      appBlockId: APP,
      connectClientId: null,
      revisionOfId: null,
      revisionOf: null,
      appBlock: { appId: CLIENT, blockId: SLUG, app: { userId: OLD_OWNER } },
    },
    [OFFSITE]: {
      id: OFFSITE,
      slug: OFFSITE_SLUG,
      kind: 'offsite',
      userId: OLD_OWNER,
      appBlockId: null,
      connectClientId: null,
      revisionOfId: null,
      revisionOf: null,
      appBlock: null,
    },
    [CONNECT_LISTING]: {
      id: CONNECT_LISTING,
      slug: 'connected-thing',
      kind: 'offsite',
      userId: OLD_OWNER,
      appBlockId: null,
      connectClientId: CONNECT_CLIENT,
      revisionOfId: null,
      revisionOf: null,
      appBlock: null,
    },
    [SHADOW]: {
      id: SHADOW,
      slug: SLUG,
      kind: 'onsite',
      userId: OLD_OWNER,
      appBlockId: null,
      connectClientId: null,
      revisionOfId: LISTING,
      revisionOf: { id: LISTING, kind: 'onsite', appBlockId: APP },
      appBlock: null,
    },
    // 🔴 offsite, but WITH a block and therefore WITH a repo slug.
    [OFFSITE_WITH_REPO]: {
      id: OFFSITE_WITH_REPO,
      slug: 'offsite-store-slug',
      kind: 'offsite',
      userId: OLD_OWNER,
      appBlockId: 'ab_offsiteBlock',
      connectClientId: null,
      revisionOfId: null,
      revisionOf: null,
      appBlock: {
        appId: 'oc_offsite',
        blockId: OFFSITE_REPO_SLUG,
        app: { userId: OLD_OWNER },
      },
    },
    // 🔴 OFFSITE, with a block whose OauthClient names STRANGER. The column (OLD_OWNER)
    // is canonical here; the block must not decide. Issue #3844.
    [OFFSITE_BLOCK_DRIFTED]: {
      id: OFFSITE_BLOCK_DRIFTED,
      slug: 'offsite-block-drifted-slug',
      kind: 'offsite',
      userId: OLD_OWNER,
      appBlockId: 'ab_offsiteDrifted',
      connectClientId: null,
      revisionOfId: null,
      revisionOf: null,
      appBlock: {
        appId: 'oc_offsiteDrifted',
        blockId: 'offsite-drifted-repo',
        app: { userId: STRANGER },
      },
    },
    // 🔴 onsite, with the canonical owner and the denormalized column DISAGREEING.
    [DRIFTED]: {
      id: DRIFTED,
      slug: 'drifted-slug',
      kind: 'onsite',
      userId: STALE_OWNER,
      appBlockId: 'ab_drifted',
      connectClientId: null,
      revisionOfId: null,
      revisionOf: null,
      appBlock: { appId: 'oc_drifted', blockId: 'drifted-repo', app: { userId: OLD_OWNER } },
    },
  };
}

let LISTINGS: Record<string, Record<string, unknown>>;

/** A live pending transfer whose `appListing` relation is taken from the table. */
function liveTransfer(over: Record<string, unknown> = {}) {
  const listingId = (over.appListingId as string) ?? LISTING;
  const l = LISTINGS[listingId];
  return {
    id: TRANSFER,
    appListingId: listingId,
    fromUserId: OLD_OWNER,
    toUserId: NEW_OWNER,
    status: 'pending',
    expiresAt: FUTURE,
    createdAt: NOW,
    appListing: {
      id: l.id,
      slug: l.slug,
      kind: l.kind,
      connectClientId: l.connectClientId,
      appBlockId: l.appBlockId,
      // 🔴 Taken FROM THE ROW, not hardcoded: the offsite-with-a-repo fixture carries a
      // different `blockId`, and a hardcoded `SLUG` here would make every Forgejo
      // assertion in this suite about the same string regardless of which listing was
      // transferred.
      appBlock: l.appBlock
        ? {
            appId: (l.appBlock as { appId: string }).appId,
            blockId: (l.appBlock as { blockId: string }).blockId,
          }
        : null,
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  LISTINGS = listingTable();
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
  mockDb.appListing.findUnique.mockImplementation(async (args: unknown): Promise<unknown> => {
    const w = (args as { where: { id?: string } }).where;
    return w.id ? LISTINGS[w.id] ?? null : null;
  });
  mockDb.appBlock.findUnique.mockResolvedValue({
    id: APP,
    appId: CLIENT,
    blockId: SLUG,
    app: { userId: OLD_OWNER },
    appListing: { id: LISTING },
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
  mockDb.appOwnershipTransfer.findUnique.mockImplementation(async () => liveTransfer());
  mockDb.appOwnershipTransfer.create.mockImplementation(async (args: unknown) => ({
    ...(args as { data: Record<string, unknown> }).data,
    createdAt: NOW,
  }));
});

describe('initiateTransfer', () => {
  it('the OWNER can offer; the row is pending with an expiry and an event is written', async () => {
    const t = await initiateTransfer({
      appListingId: LISTING,
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
      appListingId: LISTING,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
      now: NOW,
    });
    expect(mockDb.oauthClient.updateMany).not.toHaveBeenCalled();
    expect(mockDb.appListing.updateMany).not.toHaveBeenCalled();
  });

  it('a NON-OWNER cannot initiate', async () => {
    await expect(
      initiateTransfer({
        appListingId: LISTING,
        toUserId: NEW_OWNER,
        actorUserId: STRANGER,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
  });

  /**
   * 🔴 ISSUE #3844 — `loadOwnedListing` must resolve ownership KIND-AWARE.
   *
   * On an OFF-SITE listing the column is canonical and the attached block must not
   * override it. Block-first, this gate handed the power to DISPOSE OF THE LISTING to
   * whoever the block still named — the ex-owner after an off-site accept, or the
   * impersonator `claimListing` had just dispossessed. `claimListing` cancels a pending
   * transfer in the same tx precisely so the listing cannot be handed back out; a gate
   * that lets the same user open a NEW one undoes that.
   */
  describe('🔴 on an OFF-SITE listing that CARRIES A BLOCK (#3844)', () => {
    it('POSITIVE CONTROL: the fixture is offsite, has a block, and the two owners differ', () => {
      const l = LISTINGS[OFFSITE_BLOCK_DRIFTED] as {
        kind: string;
        userId: number;
        appBlock: { app: { userId: number } };
      };
      expect(l.kind).toBe('offsite');
      expect(l.userId).toBe(OLD_OWNER);
      expect(l.appBlock.app.userId).toBe(STRANGER);
      expect(OLD_OWNER).not.toBe(STRANGER);
    });

    it('the COLUMN owner may initiate', async () => {
      const t = await initiateTransfer({
        appListingId: OFFSITE_BLOCK_DRIFTED,
        toUserId: NEW_OWNER,
        actorUserId: OLD_OWNER,
        now: NOW,
      });
      expect(t.status).toBe('pending');
    });

    it('🔴 the user the BLOCK names is REFUSED — and no transfer row is written', async () => {
      await expect(
        initiateTransfer({
          appListingId: OFFSITE_BLOCK_DRIFTED,
          toUserId: NEW_OWNER,
          actorUserId: STRANGER,
          now: NOW,
        })
      ).rejects.toMatchObject({ code: 'NOT_OWNER' });
      expect(mockDb.appOwnershipTransfer.create).not.toHaveBeenCalled();
    });
  });

  it('transferring to yourself is INVALID_TARGET', async () => {
    await expect(
      initiateTransfer({
        appListingId: LISTING,
        toUserId: OLD_OWNER,
        actorUserId: OLD_OWNER,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('🔴 a BANNED recipient cannot receive ownership', async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: NEW_OWNER, bannedAt: new Date() });
    await expect(
      initiateTransfer({
        appListingId: LISTING,
        toUserId: NEW_OWNER,
        actorUserId: OLD_OWNER,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'BANNED' });
  });

  it('a SHADOW revision cannot be transferred — there is nothing to own', async () => {
    await expect(
      initiateTransfer({
        appListingId: SHADOW,
        toUserId: NEW_OWNER,
        actorUserId: OLD_OWNER,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(mockDb.appOwnershipTransfer.create).not.toHaveBeenCalled();
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
      appListingId: LISTING,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
      now: NOW,
    });
    const created = mockDb.appOwnershipTransfer.create.mock.calls[0][0] as {
      data: { fromUserId: number; toUserId: number; appListingId: string; status: string };
    };
    expect(created.data.fromUserId).toBe(OLD_OWNER);
    expect(created.data.toUserId).toBe(NEW_OWNER);
    expect(created.data.appListingId).toBe(LISTING);
    expect(created.data.status).toBe('pending');
    // …and the returned view carries the same orientation the client will render.
    expect(t.fromUserId).toBe(OLD_OWNER);
    expect(t.toUserId).toBe(NEW_OWNER);
    // POSITIVE CONTROL: the two ids are distinct, so a swap is observable at all.
    expect(OLD_OWNER).not.toBe(NEW_OWNER);
  });

  it('🔴 `fromUserId` is the listing’s CURRENT owner, not merely the actor', async () => {
    // The audit event names the target; the row must name the owner it is moving FROM.
    await initiateTransfer({
      appListingId: LISTING,
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

  it('EXPIRED pending rows are reclaimed first, so one lapsed offer cannot wedge the listing forever', async () => {
    await initiateTransfer({
      appListingId: LISTING,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
      now: NOW,
    });
    const reclaim = mockDb.appOwnershipTransfer.updateMany.mock.calls[0][0] as {
      where: { appListingId: string; status: string; expiresAt: { lte: Date } };
      data: { status: string };
    };
    expect(reclaim.where.appListingId).toBe(LISTING);
    expect(reclaim.where.status).toBe('pending');
    expect(reclaim.where.expiresAt.lte).toEqual(NOW);
    expect(reclaim.data.status).toBe('expired');
  });

  it('a concurrent second offer loses on the partial-unique index (P2002) with a friendly error', async () => {
    mockDb.appOwnershipTransfer.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    );
    await expect(
      initiateTransfer({
        appListingId: LISTING,
        toUserId: NEW_OWNER,
        actorUserId: OLD_OWNER,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'ALREADY_SEATED' });
  });

  it('🔴 NEGATIVE CONTROL: a non-P2002 error is NOT swallowed as "already pending"', async () => {
    // A broad catch here would mask genuine write failures as a benign conflict.
    mockDb.appOwnershipTransfer.create.mockRejectedValue(
      Object.assign(new Error('connection reset'), { code: 'P1001' })
    );
    await expect(
      initiateTransfer({
        appListingId: LISTING,
        toUserId: NEW_OWNER,
        actorUserId: OLD_OWNER,
        now: NOW,
      })
    ).rejects.toThrow('connection reset');
  });
});

// ---------------------------------------------------------------------------
// 🔴 THE CONNECT-CLIENT REFUSAL — the v1 scope decision, enforced at BOTH ends.
// ---------------------------------------------------------------------------

describe('🔴 an OFF-SITE listing with a connectClientId is REFUSED', () => {
  /**
   * THE DECISION. v1 moves `AppListing.userId` and nothing else. A connect listing
   * carries an `OauthClient` with a SECRET, redirect URIs and allowed origins, and both
   * silent options are bad: moving it hands over live credentials nobody agreed to
   * transfer; NOT moving it leaves ownership SPLIT between the listing and the client.
   * So the transfer is refused, with an error that says why.
   *
   * Enforced twice — at initiate (fail fast) and IN-TX at accept — because an offer stays
   * open for `transferExpiryDays`, so the initiate-time read says nothing about the row at
   * the instant of accept.
   *
   * 🔴 NOT because "a revision approve can LINK a client inside that window". That claim
   * was false and #4126 removed it from all seven places it had been copied to: no writer
   * can move `AppListing.connectClientId` from null to non-null on an EXISTING row. The
   * accept-time arm below therefore drives a state today's product cannot produce — it is
   * defence-in-depth against a future link flow, a migration or a direct DB write, and it
   * is deliberately kept as such. Canonical account: the `acceptBlockedReason` docstring
   * in `app-ownership-transfer.service.ts`.
   */
  it('the predicate is exported and states the rule in one place', () => {
    expect(
      refusesTransferForConnectClient({ kind: 'offsite', connectClientId: CONNECT_CLIENT })
    ).toBe(true);
    expect(refusesTransferForConnectClient({ kind: 'offsite', connectClientId: null })).toBe(false);
    // 🔴 ON-SITE IS UNAFFECTED — its OauthClient is reached through the AppBlock, and
    // THAT one does move. A predicate that dropped the kind check would block every
    // on-site transfer the moment the column were ever populated.
    expect(
      refusesTransferForConnectClient({ kind: 'onsite', connectClientId: CONNECT_CLIENT })
    ).toBe(false);
  });

  it('initiate REFUSES, and no transfer row is created', async () => {
    await expect(
      initiateTransfer({
        appListingId: CONNECT_LISTING,
        toUserId: NEW_OWNER,
        actorUserId: OLD_OWNER,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'INVALID_TARGET', message: CONNECT_CLIENT_TRANSFER_REFUSAL });
    expect(mockDb.appOwnershipTransfer.create).not.toHaveBeenCalled();
    expect(mockDb.appOwnershipEvent.create).not.toHaveBeenCalled();
  });

  it('🔴 the message NAMES THE REASON, and instructs NO action the owner cannot take', async () => {
    // A bare FORBIDDEN would leave the owner with no idea why, and the whole point of
    // refusing explicitly is that the reason survives to the surface.
    expect(CONNECT_CLIENT_TRANSFER_REFUSAL).toMatch(/OAuth application/i);
    expect(CONNECT_CLIENT_TRANSFER_REFUSAL).toMatch(/cannot be transferred/i);
    // …and it names the CONSEQUENCE, which is the part that makes the refusal legible.
    expect(CONNECT_CLIENT_TRANSFER_REFUSAL).toMatch(/credentials|split ownership/i);

    // 🔴 NO REMEDY, DELIBERATELY — kept as a NEGATIVE assertion because this string used
    // to end "Unlink the OAuth client first". 🔴 ITS ORIGINAL STATED REASON ("there is no
    // unlink path in the product") IS FALSE and #4126 refuted it: deleting the OAuth
    // client cascades `onDelete: SetNull` onto `AppListing.connectClientId`, so an
    // owner-initiated route out exists today. DO NOT DELETE THIS GUARD ON DISCOVERING
    // THAT — the decision to name no remedy was re-taken on its merits with the route
    // known, and the four surviving reasons are recorded at the constant.
    expect(CONNECT_CLIENT_TRANSFER_REFUSAL).not.toMatch(/unlink/i);

    // 🔴 THE WHOLE STRING, NOT A WORD. An INVARIANT GUARD, not regression coverage: it is
    // green on pre-#4126 code and pins a decision rather than a fixed bug. It exists
    // because every assertion above is walkable by REWORDING — "remove the OAuth client
    // first" or "delete your OAuth application first" satisfies `not.toMatch(/unlink/i)`
    // and every positive regex here, while re-introducing exactly the always-on false
    // instruction they were written to stop. The literal below is an INDEPENDENT copy, so
    // editing the constant moves one side only and this fails. A cosmetic reword must pay
    // for itself by updating this line — which is the point: it forces whoever changes the
    // copy to read the decision record at the constant first.
    expect(CONNECT_CLIENT_TRANSFER_REFUSAL).toBe(
      'This listing is linked to an OAuth application, so its ownership cannot be transferred: ' +
        'moving it would either hand over that application’s credentials or split ownership ' +
        'between the listing and the client.'
    );
  });

  it('🔴 ACCEPT re-asserts it: a listing that reads as linked at accept time blocks the accept', async () => {
    // What this closes: the transfer row is unchanged and only the LISTING differs from
    // what initiate saw, so an initiate-time-only check would let it through.
    //
    // 🔴 THE SETUP IS SYNTHETIC AND #4126 SAYS SO OUT LOUD. This mock returns a linked
    // listing under a live offer; the comment here used to explain that state as "a
    // revision approve then linked a client", which is FALSE — nothing in the product can
    // move `AppListing.connectClientId` from null to non-null on an existing row, and
    // initiate refuses a listing born linked. Reaching this state needs a direct DB write,
    // a migration or a future link flow. That does not make the test worthless: it pins
    // the accept-time gate as defence-in-depth, and without it the in-tx re-assert could
    // be deleted with the suite still green. It IS a reason not to cite this test as
    // evidence that the state is product-reachable.
    mockDb.appOwnershipTransfer.findUnique.mockImplementation(async () => {
      const t = liveTransfer();
      return {
        ...t,
        appListing: { ...t.appListing, kind: 'offsite', connectClientId: CONNECT_CLIENT },
      };
    });
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'INVALID_TARGET', message: CONNECT_CLIENT_TRANSFER_REFUSAL });
    // Nothing moved, and the transaction aborted.
    expect(mockDb.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockDb.oauthClient.updateMany).not.toHaveBeenCalled();
    expect(mockDb.appOwnershipEvent.create).not.toHaveBeenCalled();
    expect(calls).toContain('tx:rollback');
  });

  it('POSITIVE CONTROL: the SAME off-site listing WITHOUT a client transfers fine', async () => {
    // Otherwise "it threw" is indistinguishable from off-site transfers being broken.
    await expect(
      initiateTransfer({
        appListingId: OFFSITE,
        toUserId: NEW_OWNER,
        actorUserId: OLD_OWNER,
        now: NOW,
      })
    ).resolves.toMatchObject({ appListingId: OFFSITE, status: 'pending' });
  });
});

describe('a PENDING transfer confers NOTHING on the recipient', () => {
  it('resolveListingAccess gives the recipient no role while the offer is open', async () => {
    // The access predicate does not consult the transfer table at all — asserted by
    // observing the resolved role, which is the property that matters.
    // No SEAT exists for the recipient — the open offer is the only thing linking them
    // to the listing, and it must count for nothing.
    mockDb.appCollaborator.findFirst.mockResolvedValue(null);
    const access = await resolveListingAccess(LISTING, NEW_OWNER);
    expect(access!.role).toBeNull();
    expect(access!.ownerUserId).toBe(OLD_OWNER);
  });
});

describe('acceptTransfer — 🔴 ATOMICITY of the two ownership columns (ONSITE)', () => {
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
      where: { id: string };
      data: { userId: number };
    };
    expect(listing.where.id).toBe(LISTING);
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

  it('🔴 ONSITE: the listing write is deliberately NOT owner-guarded, so a desync cannot fail it', async () => {
    // `AppListing.userId` is a DENORMALIZED copy on an on-site listing; the canonical
    // column is the OauthClient's, already guarded above. A 0-count here is a legitimate
    // desync (or a claimListing that moved the copy), and must not fail a transfer whose
    // authority already succeeded.
    mockDb.appListing.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW })
    ).resolves.toMatchObject({ toUserId: NEW_OWNER });
    const listing = mockDb.appListing.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(listing.where).toEqual({ id: LISTING });
  });

  it('only the ADDRESSEE can accept', async () => {
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: STRANGER, now: NOW })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
    expect(mockDb.oauthClient.updateMany).not.toHaveBeenCalled();
  });

  it('🔴 an EXPIRED offer cannot be accepted', async () => {
    mockDb.appOwnershipTransfer.findUnique.mockImplementation(async () =>
      liveTransfer({ expiresAt: PAST })
    );
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'NO_INVITE' });
    expect(mockDb.oauthClient.updateMany).not.toHaveBeenCalled();
  });

  it('a CANCELLED offer cannot be accepted', async () => {
    mockDb.appOwnershipTransfer.findUnique.mockImplementation(async () =>
      liveTransfer({ status: 'cancelled' })
    );
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
// 🔴 OFF-SITE accept: one column, GUARDED, and no OauthClient / Forgejo anywhere.
// ---------------------------------------------------------------------------

describe('🔴 acceptTransfer — OFF-SITE moves ONE column, and that column IS the authority', () => {
  beforeEach(() => {
    mockDb.appOwnershipTransfer.findUnique.mockImplementation(async () =>
      liveTransfer({ appListingId: OFFSITE })
    );
  });

  it('moves AppListing.userId and NEVER touches OauthClient', async () => {
    const res = await acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW });
    expect(res).toMatchObject({ appListingId: OFFSITE, toUserId: NEW_OWNER });
    expect(mockDb.oauthClient.updateMany).not.toHaveBeenCalled();
    const listing = mockDb.appListing.updateMany.mock.calls[0][0] as {
      where: { id: string; userId: number };
      data: { userId: number };
    };
    expect(listing.data.userId).toBe(NEW_OWNER);
    // 🔴 STATUS-GUARDED on the snapshotted previous owner. Off-site has no OauthClient
    // write to guard, so this predicate is the ONLY TOCTOU protection that exists.
    expect(listing.where).toEqual({ id: OFFSITE, userId: OLD_OWNER });
  });

  it('🔴 a mod `claimListing` in the window makes the accept fail closed, not silently undo it', async () => {
    // This is the reconciliation with `offsite-moderation::claimListing`, which also
    // writes `AppListing.userId` for off-site listings. If a moderator reassigned the
    // listing after the offer was made, the guarded update matches 0 rows and the accept
    // is refused — moderator authority is final, and the pending offer becomes
    // permanently unacceptable rather than reverting the remedy.
    mockDb.appListing.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'NO_INVITE' });
    expect(mockDb.appOwnershipEvent.create).not.toHaveBeenCalled();
    expect(calls).toContain('tx:rollback');
  });

  it('touches NO Forgejo repo — there is none', async () => {
    await acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW });
    expect(mockRepo.revokeAppRepoWrite).not.toHaveBeenCalled();
    expect(mockRepo.grantAppRepoWrite).not.toHaveBeenCalled();
  });

  it('records the kind on the audit event, so the trail says WHICH shape of move happened', async () => {
    await acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW });
    const evt = mockDb.appOwnershipEvent.create.mock.calls[0][0] as {
      data: { action: string; metadata: { kind: string } };
    };
    expect(evt.data.action).toBe('transfer_accepted');
    expect(evt.data.metadata.kind).toBe('offsite');
  });

  it('🔴 POSITIVE CONTROL: the ONSITE path DOES call both, so these zeroes mean something', async () => {
    mockDb.appOwnershipTransfer.findUnique.mockImplementation(async () => liveTransfer());
    await acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW });
    expect(mockDb.oauthClient.updateMany).toHaveBeenCalledOnce();
    expect(mockRepo.grantAppRepoWrite).toHaveBeenCalledOnce();
  });

  it('an ONSITE transfer whose block record vanished is refused rather than half-applied', async () => {
    mockDb.appOwnershipTransfer.findUnique.mockImplementation(async () => {
      const t = liveTransfer();
      return { ...t, appListing: { ...t.appListing, appBlock: null } };
    });
    await expect(
      acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.appListing.updateMany).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// 🔴 acceptTransfer's post-commit Forgejo swap is gated on KIND, like step (2).
// ---------------------------------------------------------------------------

describe('🔴 the Forgejo swap and the ownership write agree about what "on-site" means', () => {
  /**
   * `acceptTransfer` makes two kind-shaped decisions and used to make them with two
   * different predicates: step (2) (move `OauthClient.userId`) branched on
   * `kind === 'onsite'`, while the post-commit repo swap branched on `blockSlug != null`.
   * On every ordinary row those agree. On an OFF-SITE listing that carries a backing
   * AppBlock they do not — and there the function did the WORSE half of both: it left the
   * OauthClient alone (correctly, per its kind) while swapping Forgejo `write` on the
   * app's repo from one user to another.
   *
   * This case is the only one that can distinguish the two predicates, so it is the only
   * one that can kill a slug-only mutant.
   */
  beforeEach(() => {
    mockDb.appOwnershipTransfer.findUnique.mockImplementation(async () =>
      liveTransfer({ appListingId: OFFSITE_WITH_REPO })
    );
  });

  it('POSITIVE CONTROL: the fixture really is offsite AND really does carry a repo slug', async () => {
    const t = liveTransfer({ appListingId: OFFSITE_WITH_REPO }) as {
      appListing: { kind: string; appBlock: { blockId: string } | null };
    };
    expect(t.appListing.kind).toBe('offsite');
    expect(t.appListing.appBlock?.blockId).toBe(OFFSITE_REPO_SLUG);
  });

  it('🔴 no repo grant and no repo revoke fire for an OFF-SITE listing that has a slug', async () => {
    await acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW });
    expect(mockRepo.revokeAppRepoWrite).not.toHaveBeenCalled();
    expect(mockRepo.grantAppRepoWrite).not.toHaveBeenCalled();
  });

  it('the OauthClient is still left alone, as its kind requires — the two agree now', async () => {
    // The structural half: both decisions must land on the same side for this row.
    await acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW });
    expect(mockDb.oauthClient.updateMany).not.toHaveBeenCalled();
    // …and the transfer itself still completes: this is a gate on the repo call, not a
    // refusal of the transfer.
    expect(mockDb.appListing.updateMany).toHaveBeenCalled();
  });

  it('🔴 POSITIVE CONTROL: THAT EXACT SLUG is swapped once the kind is onsite', async () => {
    // Without this, "not called" is indistinguishable from a repo mock nothing reaches.
    LISTINGS[OFFSITE_WITH_REPO] = { ...LISTINGS[OFFSITE_WITH_REPO], kind: 'onsite' };
    mockDb.appOwnershipTransfer.findUnique.mockImplementation(async () =>
      liveTransfer({ appListingId: OFFSITE_WITH_REPO })
    );
    await acceptTransfer({ transferId: TRANSFER, userId: NEW_OWNER, now: NOW });
    expect(mockRepo.revokeAppRepoWrite).toHaveBeenCalledWith({
      slug: OFFSITE_REPO_SLUG,
      userId: OLD_OWNER,
    });
    expect(mockRepo.grantAppRepoWrite).toHaveBeenCalledWith({
      slug: OFFSITE_REPO_SLUG,
      userId: NEW_OWNER,
    });
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

  it('accept never removes collaborator seats — the listing keeps its editors', async () => {
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

  it('a CONNECT listing’s stale offer can still be CANCELLED — refusing to move is not refusing to tidy', async () => {
    // The refusal is about MOVING ownership. An offer created before a client was linked
    // must still be withdrawable, or the partial-unique index wedges the listing.
    mockDb.appOwnershipTransfer.findUnique.mockImplementation(async () =>
      liveTransfer({ appListingId: CONNECT_LISTING })
    );
    await expect(
      cancelTransfer({ transferId: TRANSFER, actorUserId: OLD_OWNER, now: NOW })
    ).resolves.toMatchObject({ cancelled: true });
  });

  it('getPendingTransfer returns a LIVE offer', async () => {
    mockDb.appOwnershipTransfer.findFirst.mockImplementation(async () => liveTransfer());
    expect(
      await getPendingTransfer({ appListingId: LISTING, viewerUserId: OLD_OWNER, now: NOW })
    ).toMatchObject({ id: TRANSFER });
  });

  it('🔴 getPendingTransfer treats an EXPIRED row as ABSENT (read-time predicate, no sweeper needed)', async () => {
    mockDb.appOwnershipTransfer.findFirst.mockImplementation(async () =>
      liveTransfer({ expiresAt: PAST })
    );
    expect(
      await getPendingTransfer({ appListingId: LISTING, viewerUserId: OLD_OWNER, now: NOW })
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
   * author flag could ask, for any listing id, who is handing it to whom and by when —
   * a pre-announcement of an acquisition, readable by the whole flagged cohort.
   *
   * Permitted: the listing OWNER (the offer's `fromUserId`) and the ADDRESSEE. That is
   * exactly the set that may ACT on the transfer, which is what makes it consistent
   * rather than arbitrary.
   */
  const EDITOR = 30;

  beforeEach(() => {
    mockDb.appOwnershipTransfer.findFirst.mockImplementation(async () => liveTransfer());
    mockDb.appCollaborator.findFirst.mockImplementation(async (args: unknown) => {
      const w = (args as { where: { userId: number; status?: string } }).where;
      return w.userId === EDITOR && w.status === 'accepted' ? { userId: EDITOR } : null;
    });
  });

  it('the OWNER sees the offer', async () => {
    await expect(
      getPendingTransfer({ appListingId: LISTING, viewerUserId: OLD_OWNER, now: NOW })
    ).resolves.toMatchObject({ id: TRANSFER, toUserId: NEW_OWNER });
  });

  it('the ADDRESSEE sees the offer they must accept', async () => {
    await expect(
      getPendingTransfer({ appListingId: LISTING, viewerUserId: NEW_OWNER, now: NOW })
    ).resolves.toMatchObject({ id: TRANSFER });
  });

  it('🔴 a STRANGER gets null — not the row, and not a FORBIDDEN either', async () => {
    // `null`, deliberately: a throw would make this proc an EXISTENCE ORACLE, and "this
    // listing has a pending transfer" is itself the private fact. The refusal has to be
    // indistinguishable from "there is no offer".
    await expect(
      getPendingTransfer({ appListingId: LISTING, viewerUserId: STRANGER, now: NOW })
    ).resolves.toBeNull();
  });

  it('🔴 an ACCEPTED EDITOR gets null — a seat is not a claim on the listing’s disposal', async () => {
    // An editor is a co-owner for CONTENT. Initiating a transfer is one of the two
    // owner-reserved actions, so watching one is not theirs either.
    await expect(
      getPendingTransfer({ appListingId: LISTING, viewerUserId: EDITOR, now: NOW })
    ).resolves.toBeNull();
  });

  it('POSITIVE CONTROL: that same editor really does resolve as an editor', async () => {
    // Otherwise the null above proves nothing — it could be a seat lookup wired to
    // nothing rather than a deliberate exclusion.
    expect((await resolveListingAccess(LISTING, EDITOR))!.role).toBe('editor');
  });

  it('a missing listing is NOT_FOUND', async () => {
    await expect(
      getPendingTransfer({ appListingId: 'apl_nope', viewerUserId: OLD_OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the offer is looked up under the PARENT listing when asked from a shadow', async () => {
    await getPendingTransfer({ appListingId: SHADOW, viewerUserId: OLD_OWNER, now: NOW });
    expect(mockDb.appOwnershipTransfer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { appListingId: LISTING, status: 'pending' } })
    );
  });

  /**
   * 🔴 THE OWNER SIDE OF THIS GATE IS `resolveListingAccess(...).role === 'owner'`, so
   * it inherits whatever that resolver calls the owner.
   *
   * On `origin/main` this read did not exist in this shape; the re-key routed it through
   * the listing resolver, and while that resolver returned the DENORMALIZED
   * `AppListing.userId` the gate answered a different question than every sibling
   * (`initiateTransfer`/`loadOwnedListing` resolve through the shared, kind-aware
   * `resolveCanonicalListingOwner` — the block for onsite, the column for offsite).
   * The consequence is specific and inverted: the REAL owner gets `null` for their own
   * outgoing offer — which reads as "there is no transfer", the one answer that is
   * indistinguishable from safety — while the stale name reads both parties and the
   * deadline.
   */
  describe('🔴 the owner half of the gate is the CANONICAL owner', () => {
    beforeEach(() => {
      mockDb.appOwnershipTransfer.findFirst.mockImplementation(async () =>
        liveTransfer({ appListingId: DRIFTED, fromUserId: OLD_OWNER })
      );
    });

    it('POSITIVE CONTROL: the DRIFTED fixture disagrees with itself', () => {
      const l = LISTINGS[DRIFTED] as { userId: number; appBlock: { app: { userId: number } } };
      expect(l.userId).toBe(STALE_OWNER);
      expect(l.appBlock.app.userId).toBe(OLD_OWNER);
    });

    it('🔴 the REAL owner sees their own outgoing offer', async () => {
      await expect(
        getPendingTransfer({ appListingId: DRIFTED, viewerUserId: OLD_OWNER, now: NOW })
      ).resolves.toMatchObject({ id: TRANSFER, toUserId: NEW_OWNER });
    });

    it('🔴 the STALE user named by the column sees NOTHING', async () => {
      await expect(
        getPendingTransfer({ appListingId: DRIFTED, viewerUserId: STALE_OWNER, now: NOW })
      ).resolves.toBeNull();
    });
  });

  it('an EXPIRED offer is null for the owner too (expiry still wins over authorization)', async () => {
    mockDb.appOwnershipTransfer.findFirst.mockImplementation(async () =>
      liveTransfer({ expiresAt: PAST })
    );
    await expect(
      getPendingTransfer({ appListingId: LISTING, viewerUserId: OLD_OWNER, now: NOW })
    ).resolves.toBeNull();
  });
});
