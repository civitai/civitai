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
    mockRepo: { grantAppRepoWrite: vi.fn(async () => undefined), revokeAppRepoWrite: vi.fn(async () => undefined) },
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
  removeCollaborator,
  respondToInvite,
  setCollaboratorDisplayed,
  shouldNotifyInvite,
} = await import('~/server/services/blocks/app-collaborator.service');

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
    await inviteCollaborator({ appBlockId: APP, targetUserId: TARGET, actorUserId: OWNER, now: NOW });
    const args = mockDb.appCollaborator.count.mock.calls[0][0] as {
      where: { status: { in: string[] } };
    };
    expect(args.where.status.in.sort()).toEqual(['accepted', 'pending']);
  });

  it('the cap is NOT re-charged when re-touching an existing row', async () => {
    mockDb.appCollaborator.findUnique.mockResolvedValue({ status: 'pending', lastNotifiedAt: null });
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
// Byline opt-in.
// ---------------------------------------------------------------------------

describe('setCollaboratorDisplayed', () => {
  it('an ACCEPTED collaborator can toggle their byline', async () => {
    const res = await setCollaboratorDisplayed({ appBlockId: APP, userId: TARGET, displayed: false });
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
    { userId: 1, role: 'editor', status: 'accepted', displayed: true, invitedBy: OWNER, createdAt: NOW, respondedAt: NOW },
    { userId: 2, role: 'editor', status: 'pending', displayed: true, invitedBy: OWNER, createdAt: NOW, respondedAt: null },
    { userId: 3, role: 'editor', status: 'rejected', displayed: true, invitedBy: OWNER, createdAt: NOW, respondedAt: NOW },
  ];
  const ids = (rows: typeof ROWS) => rows.map((r) => r.userId);

  it('anon sees ACCEPTED only', () => {
    expect(
      ids(filterCollaboratorsForViewer(ROWS, { ownerUserId: OWNER, viewerUserId: null, isModerator: false }))
    ).toEqual([1]);
  });

  it('a stranger sees ACCEPTED only', () => {
    expect(
      ids(filterCollaboratorsForViewer(ROWS, { ownerUserId: OWNER, viewerUserId: STRANGER, isModerator: false }))
    ).toEqual([1]);
  });

  it('the OWNER sees everything', () => {
    expect(
      ids(filterCollaboratorsForViewer(ROWS, { ownerUserId: OWNER, viewerUserId: OWNER, isModerator: false }))
    ).toEqual([1, 2, 3]);
  });

  it('a MODERATOR sees everything', () => {
    expect(
      ids(filterCollaboratorsForViewer(ROWS, { ownerUserId: OWNER, viewerUserId: STRANGER, isModerator: true }))
    ).toEqual([1, 2, 3]);
  });

  it('the INVITEE sees their own pending row, but not someone else’s rejection', () => {
    expect(
      ids(filterCollaboratorsForViewer(ROWS, { ownerUserId: OWNER, viewerUserId: 2, isModerator: false }))
    ).toEqual([1, 2]);
    expect(
      ids(filterCollaboratorsForViewer(ROWS, { ownerUserId: OWNER, viewerUserId: 3, isModerator: false }))
    ).toEqual([1]);
  });

  it('an unknown status is filtered OUT — fail closed on a value the code does not know', () => {
    const weird = [{ ...ROWS[0], status: 'something-new' }];
    expect(
      filterCollaboratorsForViewer(weird, { ownerUserId: OWNER, viewerUserId: null, isModerator: false })
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
