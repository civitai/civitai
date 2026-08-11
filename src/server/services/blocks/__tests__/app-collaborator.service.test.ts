import { beforeEach, describe, expect, it, vi } from 'vitest';

import { constants } from '~/server/common/constants';

/**
 * App Listing COLLABORATORS — the SEAT lifecycle.
 *
 * Covers invite (idempotency, cap, re-open a decline, ban, self-invite), the
 * NOTIFY THROTTLE (both sides of the boundary — the inverted-sibling guard), accept /
 * reject with its status-guarded flip, remove / leave with the Forgejo revoke, the
 * byline opt-in, and the status-VISIBILITY filter.
 *
 * `dbWrite.$transaction` runs its callback against the SAME `dbWrite` mock (the tx
 * client), so a test asserts the exact writes made inside the transaction.
 * `dbRead`/`dbWrite` are the same object here — these paths do not depend on the
 * replica/primary split, and pretending otherwise would add fixture noise for no
 * assertion.
 */

const { mockDb, mockRepo, mockNotify } = vi.hoisted(() => {
  const db = {
    appBlock: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    user: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    appCollaborator: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      count: vi.fn(async (..._a: unknown[]): Promise<number> => 0),
      upsert: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
      deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
    appOwnershipEvent: { create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (cb: (tx: typeof db) => Promise<unknown>) => cb(db));
  return {
    mockDb: db,
    mockRepo: {
      grantAppRepoWrite: vi.fn(async () => undefined),
      revokeAppRepoWrite: vi.fn(async () => undefined),
    },
    mockNotify: { notifyAppCollaborator: vi.fn(async () => undefined) },
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/services/blocks/app-repo-access', () => mockRepo);
vi.mock('~/server/services/blocks/app-collaborator-notify', () => mockNotify);

const {
  AppCollaboratorError,
  filterCollaboratorsForViewer,
  inviteCollaborator,
  leaveApp,
  listCollaborators,
  mapCollaboratorError,
  removeCollaborator,
  respondToInvite,
  setCollaboratorDisplayed,
  shouldNotifyInvite,
} = await import('~/server/services/blocks/app-collaborator.service');
const { TRPCError } = await import('@trpc/server');

const APP = 'ab_app1';
const SLUG = 'my-app';
const OWNER = 10;
const TARGET = 20;
const STRANGER = 50;
const NOW = new Date('2026-08-10T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.$transaction.mockImplementation(async (cb: (tx: typeof mockDb) => Promise<unknown>) =>
    cb(mockDb)
  );
  mockDb.appBlock.findUnique.mockResolvedValue({ id: APP, blockId: SLUG, app: { userId: OWNER } });
  mockDb.user.findUnique.mockResolvedValue({ id: TARGET, bannedAt: null });
  mockDb.appCollaborator.findUnique.mockResolvedValue(null);
  mockDb.appCollaborator.count.mockResolvedValue(0);
  mockDb.appCollaborator.updateMany.mockResolvedValue({ count: 1 });
  mockDb.appCollaborator.deleteMany.mockResolvedValue({ count: 1 });
});

// ---------------------------------------------------------------------------
// The throttle — the inverted-sibling guard.
// ---------------------------------------------------------------------------

describe('shouldNotifyInvite — 🔴 the inverted-throttle guard', () => {
  const WINDOW_MS = constants.appCollaborators.inviteNotifyThrottleHours * 3600_000;

  it('never notified → notify', () => {
    expect(shouldNotifyInvite(null, NOW)).toBe(true);
  });

  it('notified LONGER ago than the window → notify', () => {
    expect(shouldNotifyInvite(new Date(NOW.getTime() - WINDOW_MS - 1000), NOW)).toBe(true);
  });

  it('🔴 notified RECENTLY → stay silent (this is the direction EntityCollaborator gets wrong)', () => {
    // `entity-collaborator.service.ts:94-95` uses `>=` here and therefore re-notifies
    // exactly when it should suppress. Both sides of the boundary are pinned so a
    // copy-paste of that comparison flips this test red.
    expect(shouldNotifyInvite(new Date(NOW.getTime() - 60_000), NOW)).toBe(false);
  });

  it('exactly ON the boundary → notify (inclusive `<=`)', () => {
    expect(shouldNotifyInvite(new Date(NOW.getTime() - WINDOW_MS), NOW)).toBe(true);
  });

  it('1 ms inside the boundary → silent', () => {
    expect(shouldNotifyInvite(new Date(NOW.getTime() - WINDOW_MS + 1), NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invite.
// ---------------------------------------------------------------------------

describe('inviteCollaborator', () => {
  it('the OWNER can invite; the row is created PENDING and an event is written', async () => {
    const res = await inviteCollaborator({
      appBlockId: APP,
      targetUserId: TARGET,
      actorUserId: OWNER,
      now: NOW,
    });
    expect(res).toMatchObject({ status: 'pending', created: true, notified: true });
    const upsert = mockDb.appCollaborator.upsert.mock.calls[0][0] as {
      create: { status: string; role: string };
    };
    expect(upsert.create.status).toBe('pending');
    expect(upsert.create.role).toBe('editor');
    const evt = mockDb.appOwnershipEvent.create.mock.calls[0][0] as { data: { action: string } };
    expect(evt.data.action).toBe('invite');
    expect(mockNotify.notifyAppCollaborator).toHaveBeenCalledOnce();
  });

  it('🔴 a NON-OWNER (even an accepted editor) cannot invite — seats are owner-managed', async () => {
    await expect(
      inviteCollaborator({ appBlockId: APP, targetUserId: TARGET, actorUserId: STRANGER, now: NOW })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
    expect(mockDb.appCollaborator.upsert).not.toHaveBeenCalled();
    expect(mockDb.appOwnershipEvent.create).not.toHaveBeenCalled();
  });

  it('inviting the OWNER is INVALID_TARGET', async () => {
    await expect(
      inviteCollaborator({ appBlockId: APP, targetUserId: OWNER, actorUserId: OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('a nonexistent target is INVALID_TARGET (never a raw FK error)', async () => {
    mockDb.user.findUnique.mockResolvedValue(null);
    await expect(
      inviteCollaborator({ appBlockId: APP, targetUserId: 999, actorUserId: OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('🔴 a BANNED target cannot be seated (the ban decision)', async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: TARGET, bannedAt: new Date() });
    await expect(
      inviteCollaborator({ appBlockId: APP, targetUserId: TARGET, actorUserId: OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'BANNED' });
    expect(mockDb.appCollaborator.upsert).not.toHaveBeenCalled();
  });

  it('re-inviting an ALREADY ACCEPTED collaborator is ALREADY_SEATED', async () => {
    mockDb.appCollaborator.findUnique.mockResolvedValue({
      status: 'accepted',
      lastNotifiedAt: null,
    });
    await expect(
      inviteCollaborator({ appBlockId: APP, targetUserId: TARGET, actorUserId: OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'ALREADY_SEATED' });
  });

  it('re-inviting a REJECTED invitee RE-OPENS it as pending (they must consent again)', async () => {
    mockDb.appCollaborator.findUnique.mockResolvedValue({
      status: 'rejected',
      lastNotifiedAt: null,
    });
    const res = await inviteCollaborator({
      appBlockId: APP,
      targetUserId: TARGET,
      actorUserId: OWNER,
      now: NOW,
    });
    expect(res.created).toBe(false);
    const upsert = mockDb.appCollaborator.upsert.mock.calls[0][0] as {
      update: { status: string; respondedAt: null };
    };
    expect(upsert.update.status).toBe('pending');
    expect(upsert.update.respondedAt).toBeNull();
  });

  it('a repeat invite inside the throttle window writes the row but sends NO notification', async () => {
    mockDb.appCollaborator.findUnique.mockResolvedValue({
      status: 'pending',
      lastNotifiedAt: new Date(NOW.getTime() - 60_000),
    });
    const res = await inviteCollaborator({
      appBlockId: APP,
      targetUserId: TARGET,
      actorUserId: OWNER,
      now: NOW,
    });
    expect(res.notified).toBe(false);
    expect(mockNotify.notifyAppCollaborator).not.toHaveBeenCalled();
  });

  it('the CAP blocks a NEW seat at the configured maximum', async () => {
    mockDb.appCollaborator.count.mockResolvedValue(constants.appCollaborators.maxCollaborators);
    await expect(
      inviteCollaborator({ appBlockId: APP, targetUserId: TARGET, actorUserId: OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'CAP_REACHED' });
  });

  it('the cap counts PENDING + ACCEPTED only — a rejected row occupies no seat', async () => {
    await inviteCollaborator({
      appBlockId: APP,
      targetUserId: TARGET,
      actorUserId: OWNER,
      now: NOW,
    });
    const args = mockDb.appCollaborator.count.mock.calls[0][0] as {
      where: { status: { in: string[] } };
    };
    expect(args.where.status.in.sort()).toEqual(['accepted', 'pending']);
  });

  it('the cap is NOT re-charged when re-touching an existing row', async () => {
    mockDb.appCollaborator.findUnique.mockResolvedValue({
      status: 'pending',
      lastNotifiedAt: null,
    });
    mockDb.appCollaborator.count.mockResolvedValue(constants.appCollaborators.maxCollaborators);
    await expect(
      inviteCollaborator({ appBlockId: APP, targetUserId: TARGET, actorUserId: OWNER, now: NOW })
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('a notification failure does NOT undo the invite (best-effort, post-commit)', async () => {
    mockNotify.notifyAppCollaborator.mockRejectedValueOnce(new Error('notifications down'));
    await expect(
      inviteCollaborator({ appBlockId: APP, targetUserId: TARGET, actorUserId: OWNER, now: NOW })
    ).resolves.toMatchObject({ status: 'pending' });
    expect(mockDb.appCollaborator.upsert).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Accept / reject.
// ---------------------------------------------------------------------------

describe('respondToInvite', () => {
  it('ACCEPT flips the row and GRANTS Forgejo write', async () => {
    const res = await respondToInvite({ appBlockId: APP, userId: TARGET, accept: true, now: NOW });
    expect(res.status).toBe('accepted');
    const upd = mockDb.appCollaborator.updateMany.mock.calls[0][0] as {
      where: { status: string };
      data: { status: string };
    };
    // 🔴 STATUS-GUARDED: only a PENDING row flips, so a concurrent remove/re-invite
    // cannot be double-acted.
    expect(upd.where.status).toBe('pending');
    expect(upd.data.status).toBe('accepted');
    expect(mockRepo.grantAppRepoWrite).toHaveBeenCalledWith({ slug: SLUG, userId: TARGET });
  });

  it('REJECT flips the row and grants NOTHING', async () => {
    const res = await respondToInvite({ appBlockId: APP, userId: TARGET, accept: false, now: NOW });
    expect(res.status).toBe('rejected');
    expect(mockRepo.grantAppRepoWrite).not.toHaveBeenCalled();
  });

  it('🔴 no pending invite → NO_INVITE, and NO event is written (tx rolled back)', async () => {
    mockDb.appCollaborator.updateMany.mockResolvedValue({ count: 0 });
    // The real $transaction rolls back on throw; the fake runs inline, so assert on the
    // ORDER instead: the guard must throw BEFORE the event create is reached.
    await expect(
      respondToInvite({ appBlockId: APP, userId: STRANGER, accept: true, now: NOW })
    ).rejects.toMatchObject({ code: 'NO_INVITE' });
    expect(mockDb.appOwnershipEvent.create).not.toHaveBeenCalled();
    expect(mockRepo.grantAppRepoWrite).not.toHaveBeenCalled();
  });

  it('🔴 a BANNED user cannot ACCEPT', async () => {
    mockDb.user.findUnique.mockResolvedValue({ bannedAt: new Date() });
    await expect(
      respondToInvite({ appBlockId: APP, userId: TARGET, accept: true, now: NOW })
    ).rejects.toMatchObject({ code: 'BANNED' });
  });

  it('a BANNED user CAN decline (declining takes nothing away from anyone)', async () => {
    mockDb.user.findUnique.mockResolvedValue({ bannedAt: new Date() });
    await expect(
      respondToInvite({ appBlockId: APP, userId: TARGET, accept: false, now: NOW })
    ).resolves.toMatchObject({ status: 'rejected' });
  });

  // 🔴 The APPEND-ONLY TRAIL's `action` field. Untested until a mutation sweep swapped
  // the ternary and nothing went red: an accept was recorded as a `reject`. The trail is
  // the ONLY record of who consented to what — the seat row itself is deleted on
  // remove/leave — so a silently-inverted action makes the audit history actively
  // misleading rather than merely incomplete, and nothing downstream would ever
  // contradict it.
  it('🔴 ACCEPT is recorded as `accept` in the audit trail', async () => {
    await respondToInvite({ appBlockId: APP, userId: TARGET, accept: true, now: NOW });
    const evt = mockDb.appOwnershipEvent.create.mock.calls[0][0] as {
      data: { action: string; actorUserId: number; targetUserId: number };
    };
    expect(evt.data.action).toBe('accept');
    expect(evt.data.actorUserId).toBe(TARGET);
    expect(evt.data.targetUserId).toBe(TARGET);
  });

  it('🔴 REJECT is recorded as `reject` — the two are not interchangeable', async () => {
    await respondToInvite({ appBlockId: APP, userId: TARGET, accept: false, now: NOW });
    const evt = mockDb.appOwnershipEvent.create.mock.calls[0][0] as { data: { action: string } };
    expect(evt.data.action).toBe('reject');
  });

  it('POSITIVE CONTROL: the two branches really do write DIFFERENT actions', async () => {
    // Otherwise both assertions above could be satisfied by one constant string.
    await respondToInvite({ appBlockId: APP, userId: TARGET, accept: true, now: NOW });
    const a = (mockDb.appOwnershipEvent.create.mock.calls[0][0] as { data: { action: string } })
      .data.action;
    mockDb.appOwnershipEvent.create.mockClear();
    await respondToInvite({ appBlockId: APP, userId: TARGET, accept: false, now: NOW });
    const b = (mockDb.appOwnershipEvent.create.mock.calls[0][0] as { data: { action: string } })
      .data.action;
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Remove / leave.
// ---------------------------------------------------------------------------

describe('removeCollaborator / leaveApp — the REVOKE half', () => {
  it('the owner removes a seat and the repo grant is REVOKED', async () => {
    const res = await removeCollaborator({
      appBlockId: APP,
      targetUserId: TARGET,
      actorUserId: OWNER,
    });
    expect(res.removed).toBe(true);
    expect(mockRepo.revokeAppRepoWrite).toHaveBeenCalledWith({ slug: SLUG, userId: TARGET });
  });

  it('a NON-OWNER cannot remove someone else', async () => {
    await expect(
      removeCollaborator({ appBlockId: APP, targetUserId: TARGET, actorUserId: STRANGER })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
    expect(mockRepo.revokeAppRepoWrite).not.toHaveBeenCalled();
  });

  it('removing a seat that does not exist is a no-op and revokes nothing', async () => {
    mockDb.appCollaborator.deleteMany.mockResolvedValue({ count: 0 });
    const res = await removeCollaborator({
      appBlockId: APP,
      targetUserId: TARGET,
      actorUserId: OWNER,
    });
    expect(res.removed).toBe(false);
    expect(mockRepo.revokeAppRepoWrite).not.toHaveBeenCalled();
    expect(mockDb.appOwnershipEvent.create).not.toHaveBeenCalled();
  });

  it('a COLLABORATOR may leave without any owner check — and is revoked', async () => {
    const res = await leaveApp({ appBlockId: APP, userId: TARGET });
    expect(res.removed).toBe(true);
    expect(mockRepo.revokeAppRepoWrite).toHaveBeenCalledWith({ slug: SLUG, userId: TARGET });
    const evt = mockDb.appOwnershipEvent.create.mock.calls[0][0] as { data: { action: string } };
    expect(evt.data.action).toBe('leave');
  });
});

// ---------------------------------------------------------------------------
// 🔴 THE BLAST RADIUS of the two `deleteMany` calls.
// ---------------------------------------------------------------------------

describe('🔴 leaveApp / removeCollaborator delete EXACTLY ONE seat', () => {
  /**
   * THE WORST SURVIVING MUTANT. Dropping `userId` from `leaveApp`'s `where` turns "I
   * give up my seat" into "every collaborator on this app is removed" — a one-word
   * deletion, performed by a NON-OWNER (leaving needs no owner check, correctly), that
   * no test noticed. The old fixture asserted only `deleteMany` returned `count: 1`,
   * which a table-wide delete satisfies just as well as a targeted one.
   *
   * So this suite stops asserting the RETURN and starts asserting the TABLE: a real
   * two-seat fixture, a `deleteMany` that honours its `where`, and an assertion on who
   * SURVIVES. A predicate that is too broad now leaves the wrong survivors.
   */
  const OTHER_SEAT = 21;

  /** The seat table, mutated for real by the fake `deleteMany`. */
  let seats: Array<{ appBlockId: string; userId: number }>;

  beforeEach(() => {
    seats = [
      { appBlockId: APP, userId: TARGET },
      { appBlockId: APP, userId: OTHER_SEAT },
      // A seat on a DIFFERENT app, so an over-broad `where` that keeps `userId` but
      // drops `appBlockId` is caught too.
      { appBlockId: 'ab_other', userId: TARGET },
    ];
    mockDb.appCollaborator.deleteMany.mockImplementation(async (args: unknown) => {
      const w = (args as { where: { appBlockId?: string; userId?: number } }).where;
      const before = seats.length;
      seats = seats.filter(
        (s) =>
          !(
            (w.appBlockId === undefined || s.appBlockId === w.appBlockId) &&
            (w.userId === undefined || s.userId === w.userId)
          )
      );
      return { count: before - seats.length };
    });
  });

  it('POSITIVE CONTROL: the fake deleteMany really does honour its `where`', async () => {
    // Without this the survivor assertions below are facts about an inert mock.
    const wide = await mockDb.appCollaborator.deleteMany({ where: {} });
    expect(wide).toEqual({ count: 3 });
    expect(seats).toEqual([]);
  });

  it('🔴 leaveApp removes ONLY the caller’s seat on THIS app', async () => {
    const res = await leaveApp({ appBlockId: APP, userId: TARGET });
    expect(res.removed).toBe(true);
    // The co-editor keeps their seat. A `where` missing `userId` deletes them too.
    expect(seats).toContainEqual({ appBlockId: APP, userId: OTHER_SEAT });
    // …and the caller's seat on an unrelated app survives. A `where` missing
    // `appBlockId` takes that one.
    expect(seats).toContainEqual({ appBlockId: 'ab_other', userId: TARGET });
    expect(seats).not.toContainEqual({ appBlockId: APP, userId: TARGET });
    expect(seats).toHaveLength(2);
  });

  it('🔴 leaveApp revokes repo write for the LEAVER only', async () => {
    await leaveApp({ appBlockId: APP, userId: TARGET });
    expect(mockRepo.revokeAppRepoWrite).toHaveBeenCalledOnce();
    expect(mockRepo.revokeAppRepoWrite).toHaveBeenCalledWith({ slug: SLUG, userId: TARGET });
  });

  it('🔴 removeCollaborator removes ONLY the named target', async () => {
    await removeCollaborator({ appBlockId: APP, targetUserId: TARGET, actorUserId: OWNER });
    expect(seats).toContainEqual({ appBlockId: APP, userId: OTHER_SEAT });
    expect(seats).not.toContainEqual({ appBlockId: APP, userId: TARGET });
  });

  it('leaving an app you hold no seat on removes nothing and revokes nothing', async () => {
    const res = await leaveApp({ appBlockId: APP, userId: STRANGER });
    expect(res.removed).toBe(false);
    expect(seats).toHaveLength(3);
    expect(mockRepo.revokeAppRepoWrite).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 🔴 The audit event must be written through the TRANSACTION, not the client.
// ---------------------------------------------------------------------------

describe('🔴 recordOwnershipEvent writes through the `tx`, not `dbWrite`', () => {
  /**
   * FIXTURE COLLAPSE, and why this needed its own describe.
   *
   * Every suite's `$transaction` fake calls back with the SAME object it was called on
   * (`cb(db)`), so `tx.appOwnershipEvent.create` and `dbWrite.appOwnershipEvent.create`
   * are literally the same spy. A mutant that swapped the transactional client for the
   * bare `dbWrite` was therefore byte-identical to correct code under test — and it is
   * the one difference that matters: an event written outside the transaction SURVIVES
   * a rollback, so a seat change that never happened leaves a permanent audit row
   * claiming it did.
   *
   * The cure is a DISTINCT tx double. Two objects make the choice observable; one
   * object makes the assertion unwritable.
   */
  function txDouble() {
    return {
      appCollaborator: {
        upsert: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
        updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
        deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
      },
      appOwnershipEvent: { create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})) },
    };
  }

  let tx: ReturnType<typeof txDouble>;

  beforeEach(() => {
    tx = txDouble();
    mockDb.$transaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  });

  it('POSITIVE CONTROL: the tx double is a DIFFERENT object from the client', () => {
    // If these were the same object every assertion below would be vacuous — which is
    // exactly the state that let the mutant survive.
    expect(tx.appOwnershipEvent.create).not.toBe(mockDb.appOwnershipEvent.create);
  });

  const CASES: Array<[string, () => Promise<unknown>, string]> = [
    [
      'inviteCollaborator',
      () =>
        inviteCollaborator({ appBlockId: APP, targetUserId: TARGET, actorUserId: OWNER, now: NOW }),
      'invite',
    ],
    [
      'respondToInvite',
      () => respondToInvite({ appBlockId: APP, userId: TARGET, accept: true, now: NOW }),
      'accept',
    ],
    [
      'removeCollaborator',
      () => removeCollaborator({ appBlockId: APP, targetUserId: TARGET, actorUserId: OWNER }),
      'remove',
    ],
    ['leaveApp', () => leaveApp({ appBlockId: APP, userId: TARGET }), 'leave'],
    [
      'setCollaboratorDisplayed',
      () => setCollaboratorDisplayed({ appBlockId: APP, userId: TARGET, displayed: true }),
      'display',
    ],
  ];

  for (const [label, run, action] of CASES) {
    it(`${label}: the \`${action}\` event lands on the tx and NOT on the client`, async () => {
      await run();
      expect(tx.appOwnershipEvent.create).toHaveBeenCalledOnce();
      const evt = tx.appOwnershipEvent.create.mock.calls[0][0] as { data: { action: string } };
      expect(evt.data.action).toBe(action);
      // 🔴 The mutant's signature: the event written through the bare client, where a
      // rollback cannot reach it.
      expect(mockDb.appOwnershipEvent.create).not.toHaveBeenCalled();
    });
  }

  it('the seat WRITE goes through the tx too, not just the event', async () => {
    await respondToInvite({ appBlockId: APP, userId: TARGET, accept: true, now: NOW });
    expect(tx.appCollaborator.updateMany).toHaveBeenCalledOnce();
    expect(mockDb.appCollaborator.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Byline opt-in.
// ---------------------------------------------------------------------------

describe('setCollaboratorDisplayed', () => {
  it('an ACCEPTED collaborator can toggle their byline', async () => {
    const res = await setCollaboratorDisplayed({
      appBlockId: APP,
      userId: TARGET,
      displayed: false,
    });
    expect(res.displayed).toBe(false);
    const upd = mockDb.appCollaborator.updateMany.mock.calls[0][0] as {
      where: { status: string };
      data: { displayed: boolean };
    };
    // 🔴 Guarded on ACCEPTED: a pending invitee must not be able to pre-arrange public
    // credit for a seat they have not taken.
    expect(upd.where.status).toBe('accepted');
    expect(upd.data.displayed).toBe(false);
  });

  it('a non-accepted (or absent) row is refused', async () => {
    mockDb.appCollaborator.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      setCollaboratorDisplayed({ appBlockId: APP, userId: STRANGER, displayed: true })
    ).rejects.toMatchObject({ code: 'NO_INVITE' });
  });
});

// ---------------------------------------------------------------------------
// Status visibility (the consent model borrowed from EntityCollaborator).
// ---------------------------------------------------------------------------

describe('filterCollaboratorsForViewer — status visibility', () => {
  const ROWS = [
    {
      userId: 1,
      role: 'editor',
      status: 'accepted',
      displayed: true,
      invitedBy: OWNER,
      createdAt: NOW,
      respondedAt: NOW,
    },
    {
      userId: 2,
      role: 'editor',
      status: 'pending',
      displayed: true,
      invitedBy: OWNER,
      createdAt: NOW,
      respondedAt: null,
    },
    {
      userId: 3,
      role: 'editor',
      status: 'rejected',
      displayed: true,
      invitedBy: OWNER,
      createdAt: NOW,
      respondedAt: NOW,
    },
  ];
  const ids = (rows: typeof ROWS) => rows.map((r) => r.userId);

  it('anon sees ACCEPTED only', () => {
    expect(
      ids(
        filterCollaboratorsForViewer(ROWS, {
          ownerUserId: OWNER,
          viewerUserId: null,
          isModerator: false,
        })
      )
    ).toEqual([1]);
  });

  it('a stranger sees ACCEPTED only', () => {
    expect(
      ids(
        filterCollaboratorsForViewer(ROWS, {
          ownerUserId: OWNER,
          viewerUserId: STRANGER,
          isModerator: false,
        })
      )
    ).toEqual([1]);
  });

  it('the OWNER sees everything', () => {
    expect(
      ids(
        filterCollaboratorsForViewer(ROWS, {
          ownerUserId: OWNER,
          viewerUserId: OWNER,
          isModerator: false,
        })
      )
    ).toEqual([1, 2, 3]);
  });

  it('a MODERATOR sees everything', () => {
    expect(
      ids(
        filterCollaboratorsForViewer(ROWS, {
          ownerUserId: OWNER,
          viewerUserId: STRANGER,
          isModerator: true,
        })
      )
    ).toEqual([1, 2, 3]);
  });

  it('the INVITEE sees their own pending row, but not someone else’s rejection', () => {
    expect(
      ids(
        filterCollaboratorsForViewer(ROWS, {
          ownerUserId: OWNER,
          viewerUserId: 2,
          isModerator: false,
        })
      )
    ).toEqual([1, 2]);
    expect(
      ids(
        filterCollaboratorsForViewer(ROWS, {
          ownerUserId: OWNER,
          viewerUserId: 3,
          isModerator: false,
        })
      )
    ).toEqual([1]);
  });

  it('an unknown status is filtered OUT — fail closed on a value the code does not know', () => {
    const weird = [{ ...ROWS[0], status: 'something-new' }];
    expect(
      filterCollaboratorsForViewer(weird, {
        ownerUserId: OWNER,
        viewerUserId: null,
        isModerator: false,
      })
    ).toEqual([]);
  });
});

describe('AppCollaboratorError', () => {
  it('carries its code (the router maps on it)', () => {
    const e = new AppCollaboratorError('CAP_REACHED', 'too many');
    expect(e.code).toBe('CAP_REACHED');
    expect(e.name).toBe('AppCollaboratorError');
  });
});

// ---------------------------------------------------------------------------
// 🔴 The tRPC STATUS-CODE contract for the whole new router.
// ---------------------------------------------------------------------------

describe('mapCollaboratorError — the router’s status-code contract', () => {
  /**
   * Every proc in `app-collaborators.router.ts` funnels through `run()` → this
   * function, so this table IS the router's error contract. It was entirely untested:
   * a mutant returning BAD_REQUEST for NOT_OWNER/BANNED survived, which would turn
   * "you are not allowed" into "your request was malformed" for every authorization
   * failure the feature can produce — the client cannot tell a permission problem from
   * a bad payload, and neither can a support agent reading a ticket.
   *
   * Asserted as an exhaustive table over `AppCollaboratorErrorCode` (the codes are
   * listed, not derived from the implementation) so a NEW code added without a decision
   * shows up as an unlisted case in the union rather than silently defaulting.
   */
  const CONTRACT: Array<[string, string]> = [
    ['NOT_FOUND', 'NOT_FOUND'],
    // 🔴 The two authorization codes. FORBIDDEN, never BAD_REQUEST.
    ['NOT_OWNER', 'FORBIDDEN'],
    ['BANNED', 'FORBIDDEN'],
    // Everything else is the caller asking for something the state does not allow.
    ['INVALID_TARGET', 'BAD_REQUEST'],
    ['ALREADY_SEATED', 'BAD_REQUEST'],
    ['CAP_REACHED', 'BAD_REQUEST'],
    ['NO_INVITE', 'BAD_REQUEST'],
  ];

  for (const [serviceCode, trpcCode] of CONTRACT) {
    it(`${serviceCode} → tRPC ${trpcCode}`, () => {
      const mapped = mapCollaboratorError(
        new AppCollaboratorError(serviceCode as never, `msg-${serviceCode}`)
      );
      expect(mapped).toBeInstanceOf(TRPCError);
      expect((mapped as InstanceType<typeof TRPCError>).code).toBe(trpcCode);
      // The service message reaches the client verbatim — these strings are the UX.
      expect((mapped as InstanceType<typeof TRPCError>).message).toBe(`msg-${serviceCode}`);
    });
  }

  it('the table covers EVERY code the service can throw (no silently-unmapped case)', () => {
    // A structural guard against the table drifting behind the union: the codes below
    // are the ones `AppCollaboratorErrorCode` declares.
    const DECLARED = [
      'NOT_FOUND',
      'NOT_OWNER',
      'INVALID_TARGET',
      'ALREADY_SEATED',
      'CAP_REACHED',
      'NO_INVITE',
      'BANNED',
    ];
    expect(CONTRACT.map(([c]) => c).sort()).toEqual(DECLARED.sort());
  });

  it('🔴 NEGATIVE CONTROL: a non-service error passes through UNCHANGED', () => {
    // Wrapping everything would relabel genuine 500s as client errors.
    const raw = new Error('connection reset');
    expect(mapCollaboratorError(raw)).toBe(raw);
    expect(mapCollaboratorError(raw)).not.toBeInstanceOf(TRPCError);
  });

  it('POSITIVE CONTROL: FORBIDDEN and BAD_REQUEST are distinguishable values', () => {
    // Otherwise the whole table could be satisfied by one constant.
    const a = mapCollaboratorError(new AppCollaboratorError('NOT_OWNER', 'x'));
    const b = mapCollaboratorError(new AppCollaboratorError('CAP_REACHED', 'x'));
    expect((a as InstanceType<typeof TRPCError>).code).not.toBe(
      (b as InstanceType<typeof TRPCError>).code
    );
  });
});

// ---------------------------------------------------------------------------
// 🔴 The ROSTER read is not public.
// ---------------------------------------------------------------------------

describe('listCollaborators — 🔴 the caller must hold a REAL role', () => {
  /**
   * `resolveAppAccess` was consulted here only for `ownerUserId`; its `role` was never
   * required non-null. The status filter governs which ROWS a viewer sees, not whether
   * the viewer may read the app at all — so any account with the author flag could
   * enumerate ANY app's accepted roster, INCLUDING seats whose holder set
   * `displayed: false` precisely so as not to be listed publicly, plus `invitedBy` and
   * the invite/response timestamps.
   */
  const ROSTER = [
    {
      userId: 1,
      role: 'editor',
      status: 'accepted',
      displayed: false,
      invitedBy: OWNER,
      createdAt: NOW,
      respondedAt: NOW,
    },
  ];

  beforeEach(() => {
    mockDb.appCollaborator.findMany.mockResolvedValue(ROSTER);
    // No seat for anyone unless a test says otherwise.
    mockDb.appCollaborator.findFirst.mockResolvedValue(null);
  });

  it('the OWNER may read the roster', async () => {
    await expect(
      listCollaborators({ appBlockId: APP, viewerUserId: OWNER, isModerator: false })
    ).resolves.toHaveLength(1);
  });

  it('an ACCEPTED editor may read the roster', async () => {
    mockDb.appCollaborator.findFirst.mockResolvedValue({ userId: TARGET });
    await expect(
      listCollaborators({ appBlockId: APP, viewerUserId: TARGET, isModerator: false })
    ).resolves.toHaveLength(1);
  });

  it('a MODERATOR may read the roster', async () => {
    await expect(
      listCollaborators({ appBlockId: APP, viewerUserId: STRANGER, isModerator: true })
    ).resolves.toHaveLength(1);
  });

  it('🔴 a STRANGER is refused — and the query never runs', async () => {
    await expect(
      listCollaborators({ appBlockId: APP, viewerUserId: STRANGER, isModerator: false })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
    // Fail BEFORE the read, not after it: the rows must never be loaded, let alone
    // filtered.
    expect(mockDb.appCollaborator.findMany).not.toHaveBeenCalled();
  });

  it('🔴 an ANONYMOUS caller is refused', async () => {
    await expect(
      listCollaborators({ appBlockId: APP, viewerUserId: null, isModerator: false })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
  });

  it('🔴 a PENDING invitee is refused (they read their own invite via listMyPendingInvites)', async () => {
    // `resolveAppAccess` returns role null for a pending seat — the consent rule. So a
    // pending invitee does not get the app's roster as a side effect of being invited.
    mockDb.appCollaborator.findFirst.mockImplementation(async (args: unknown) => {
      const w = (args as { where: { status?: string } }).where;
      return w.status === 'accepted' ? null : { userId: TARGET };
    });
    await expect(
      listCollaborators({ appBlockId: APP, viewerUserId: TARGET, isModerator: false })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
  });

  it('a missing app is NOT_FOUND, distinct from a refusal', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue(null);
    await expect(
      listCollaborators({ appBlockId: APP, viewerUserId: OWNER, isModerator: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('POSITIVE CONTROL: the roster fixture really carries an opted-OUT seat', async () => {
    // The stake of the leak, stated as data: `displayed: false` is exactly the row a
    // stranger must not be able to read back.
    const rows = await listCollaborators({
      appBlockId: APP,
      viewerUserId: OWNER,
      isModerator: false,
    });
    expect(rows[0].displayed).toBe(false);
    expect(rows[0].invitedBy).toBe(OWNER);
  });
});
