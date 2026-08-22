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
 * 🔴 Since the block→listing re-key, two axes are new and are exercised throughout:
 * the listing KIND (an OFF-SITE listing has no Forgejo repo, so every grant/revoke must
 * be SKIPPED rather than called with a slug that names nothing), and the SHADOW
 * REVISION hazard (a seat may only exist on a parent).
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
    appListing: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
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
  listMyPendingInvites,
  mapCollaboratorError,
  removeCollaborator,
  respondToInvite,
  setCollaboratorDisplayed,
  shouldNotifyInvite,
} = await import('~/server/services/blocks/app-collaborator.service');
const { TRPCError } = await import('@trpc/server');

const APP = 'ab_app1';
const SLUG = 'my-app';
/** The ON-SITE parent listing — has a backing AppBlock, so it has a Forgejo repo. */
const LISTING = 'apl_live';
/** The OFF-SITE parent listing — no AppBlock, no repo, no earnings. */
const OFFSITE = 'apl_offsite';
const OFFSITE_SLUG = 'cool-offsite';
/** A shadow revision of the on-site parent. No seat may EVER live here. */
const SHADOW = 'apl_shadow';
/**
 * 🔴 An OFF-SITE listing that DOES carry a backing AppBlock — the shape where "offsite"
 * and "has no repo slug" disagree. `mapAppBlockToListing` mints exactly this for an
 * AppBlock with an `externalUrl` (`kind: 'offsite'` + `appBlockId: ab.id`), reachable via
 * the mod proc `backfillAppListings`. Every Forgejo gate that keys on the SLUG alone
 * would fire on it.
 */
const OFFSITE_WITH_REPO = 'apl_offsite_with_repo';
const OFFSITE_REPO_SLUG = 'offsite-repo';
/**
 * 🔴 An ON-SITE listing with NO backing AppBlock — the OTHER shape where the two clauses
 * of `hasWritableRepo` disagree, and the mirror image of {@link OFFSITE_WITH_REPO}. Here
 * the KIND says `submitVersion: true` and only `blockSlug != null` can refuse.
 *
 * It is a real row, not a hypothetical: `publish-request.service::submitVersion`'s
 * first-version branch matches a pre-approval draft on
 * `kind = 'onsite' AND status = 'draft' AND appBlockId IS NULL`, so an on-site listing
 * exists without a block for the whole window before its first approval.
 */
const ONSITE_NO_BLOCK = 'apl_onsite_no_block';
/**
 * 🔴 An ON-SITE listing whose denormalized `AppListing.userId` DISAGREES with its
 * canonical `OauthClient.userId`. This state is one the feature's own code produces, via
 * a SHADOW REVISION: `beginListingRevision` clones the column and no ownership write ever
 * revisits the clone, so a shadow that outlives a transfer names the old owner forever.
 * (NOT via `acceptTransfer`'s onsite listing write — that one is `where: { id }`,
 * unconditional and in the same tx as the OauthClient move, so it heals the parent rather
 * than drifting it. The full mechanism is in
 * `app-access.denormalized-owner-drift.test.ts`.)
 */
const DRIFTED = 'apl_drifted';
/**
 * 🔴 An OFF-SITE listing that carries a block whose `OauthClient.userId` names SOMEONE
 * ELSE — issue #3844. For an off-site listing `AppListing.userId` IS the owner (there is
 * no OauthClient in the chain), and both off-site ownership writers (`acceptTransfer`'s
 * offsite path, `claimListing`) move only that column, so the attached block keeps naming
 * whoever owned it before. `toSeatListing` resolved BLOCK-FIRST until #3844, which meant
 * `assertOwner` — seat MANAGEMENT — was answered by the block: the dispossessed
 * impersonator could still invite and remove collaborators on the rightful owner's app.
 */
const OFFSITE_BLOCK_DRIFTED = 'apl_offsite_block_drifted';
const OWNER = 10;
const TARGET = 20;
const STRANGER = 50;
/** A SECOND accepted collaborator — the "an editor is not an owner" fixture. */
const SECOND_SEAT = 30;
/**
 * The refusal `setCollaboratorDisplayed` raises for a non-owner acting on someone ELSE's
 * seat. Asserted VERBATIM so a mutant that breaks this gate dies to THIS error rather
 * than to a neighbouring owner check (`assertOwner`'s message is different on purpose).
 */
const BYLINE_NOT_OWNER_MESSAGE = 'Only the app owner can change a collaborator’s public byline';
/** The name left behind in a stale denormalized `AppListing.userId`. */
const STALE_OWNER = 77;
const NOW = new Date('2026-08-10T12:00:00Z');

/**
 * The listing table the fixture serves, keyed by id.
 *
 * 🔴 PAIRWISE-DISTINCT VALUES on purpose: the on-site and off-site rows differ in id,
 * slug, kind, appBlockId AND appBlock, so an assertion cannot be satisfied by the wrong
 * row happening to look like the right one.
 */
function listingTable(): Record<string, Record<string, unknown>> {
  return {
    [LISTING]: {
      id: LISTING,
      slug: SLUG,
      kind: 'onsite',
      userId: OWNER,
      appBlockId: APP,
      revisionOfId: null,
      revisionOf: null,
      appBlock: { appId: 'oc_app1', blockId: SLUG, app: { userId: OWNER } },
    },
    [OFFSITE]: {
      id: OFFSITE,
      slug: OFFSITE_SLUG,
      kind: 'offsite',
      userId: OWNER,
      appBlockId: null,
      revisionOfId: null,
      revisionOf: null,
      appBlock: null,
    },
    [SHADOW]: {
      id: SHADOW,
      slug: SLUG,
      kind: 'onsite',
      userId: OWNER,
      // A shadow carries appBlockId: null by construction (@unique stays on the parent).
      appBlockId: null,
      revisionOfId: LISTING,
      revisionOf: { id: LISTING, kind: 'onsite', appBlockId: APP },
      appBlock: null,
    },
    // 🔴 offsite, but WITH a block and therefore WITH a repo slug.
    [OFFSITE_WITH_REPO]: {
      id: OFFSITE_WITH_REPO,
      slug: 'offsite-store-slug',
      kind: 'offsite',
      userId: OWNER,
      appBlockId: 'ab_offsiteBlock',
      revisionOfId: null,
      revisionOf: null,
      appBlock: {
        appId: 'oc_offsite',
        blockId: OFFSITE_REPO_SLUG,
        app: { userId: OWNER },
      },
    },
    // 🔴 onsite, but with NO block and therefore NO repo slug.
    [ONSITE_NO_BLOCK]: {
      id: ONSITE_NO_BLOCK,
      slug: 'onsite-no-block-slug',
      kind: 'onsite',
      userId: OWNER,
      appBlockId: null,
      revisionOfId: null,
      revisionOf: null,
      appBlock: null,
    },
    // 🔴 OFFSITE, carrying a block whose OauthClient names someone ELSE — issue #3844.
    // The column is canonical for an off-site listing, so OWNER owns this row and
    // STRANGER (whom the block names) does not.
    [OFFSITE_BLOCK_DRIFTED]: {
      id: OFFSITE_BLOCK_DRIFTED,
      slug: 'offsite-block-drifted',
      kind: 'offsite',
      userId: OWNER,
      appBlockId: 'ab_offsiteDrifted',
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
      revisionOfId: null,
      revisionOf: null,
      appBlock: { appId: 'oc_drifted', blockId: 'drifted-repo', app: { userId: OWNER } },
    },
  };
}

let LISTINGS: Record<string, Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  LISTINGS = listingTable();
  mockDb.$transaction.mockImplementation(async (cb: (tx: typeof mockDb) => Promise<unknown>) =>
    cb(mockDb)
  );
  mockDb.appListing.findUnique.mockImplementation(async (args: unknown): Promise<unknown> => {
    const w = (args as { where: { id?: string; appBlockId?: string } }).where;
    if (w.id) return LISTINGS[w.id] ?? null;
    if (w.appBlockId) {
      return Object.values(LISTINGS).find((l) => l.appBlockId === w.appBlockId) ?? null;
    }
    return null;
  });
  mockDb.appBlock.findUnique.mockResolvedValue({
    id: APP,
    blockId: SLUG,
    app: { userId: OWNER },
    appListing: { id: LISTING },
  });
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
      appListingId: LISTING,
      targetUserId: TARGET,
      actorUserId: OWNER,
      now: NOW,
    });
    expect(res).toMatchObject({ status: 'pending', created: true, notified: true });
    const upsert = mockDb.appCollaborator.upsert.mock.calls[0][0] as {
      create: { status: string; role: string; appListingId: string };
    };
    expect(upsert.create.status).toBe('pending');
    expect(upsert.create.role).toBe('editor');
    // 🔴 The re-key, at the write side: the seat is stored under the LISTING id.
    expect(upsert.create.appListingId).toBe(LISTING);
    const evt = mockDb.appOwnershipEvent.create.mock.calls[0][0] as {
      data: { action: string; appListingId: string };
    };
    expect(evt.data.action).toBe('invite');
    expect(evt.data.appListingId).toBe(LISTING);
    expect(mockNotify.notifyAppCollaborator).toHaveBeenCalledOnce();
  });

  it('🔴 an OFF-SITE listing can be seated — the whole point of the re-key', async () => {
    const res = await inviteCollaborator({
      appListingId: OFFSITE,
      targetUserId: TARGET,
      actorUserId: OWNER,
      now: NOW,
    });
    expect(res).toMatchObject({ appListingId: OFFSITE, status: 'pending', created: true });
    const upsert = mockDb.appCollaborator.upsert.mock.calls[0][0] as {
      create: { appListingId: string };
    };
    expect(upsert.create.appListingId).toBe(OFFSITE);
  });

  it('🔴 the OFF-SITE owner is the LISTING’s userId — there is no OauthClient in that chain', async () => {
    // The onsite owner comes from `appBlock.app.userId`; offsite has no appBlock, so the
    // column IS the owner. A resolver that only ever read `appBlock.app.userId` would
    // refuse every off-site owner with NOT_OWNER.
    LISTINGS[OFFSITE] = { ...LISTINGS[OFFSITE], userId: 777 };
    await expect(
      inviteCollaborator({
        appListingId: OFFSITE,
        targetUserId: TARGET,
        actorUserId: 777,
        now: NOW,
      })
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('🔴 ONSITE ownership is the OauthClient’s, even when the listing’s copy is STALE', async () => {
    // `AppListing.userId` is a DENORMALIZED copy for an on-site listing, and it can
    // legitimately drift (a mod `claimListing`, a partial write, a backfill). The
    // canonical owner is `AppBlock.app.userId`. Resolving from the copy would let a
    // stale row lock the REAL owner out of managing their own collaborators — and would
    // let whoever the stale row names in.
    LISTINGS[LISTING] = { ...LISTINGS[LISTING], userId: 999 };
    await expect(
      inviteCollaborator({
        appListingId: LISTING,
        targetUserId: TARGET,
        actorUserId: OWNER,
        now: NOW,
      })
    ).resolves.toMatchObject({ status: 'pending' });
    // …and the stale name does NOT get in.
    await expect(
      inviteCollaborator({
        appListingId: LISTING,
        targetUserId: TARGET,
        actorUserId: 999,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
  });

  it('🔴 a NON-OWNER (even an accepted editor) cannot invite — seats are owner-managed', async () => {
    await expect(
      inviteCollaborator({
        appListingId: LISTING,
        targetUserId: TARGET,
        actorUserId: STRANGER,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
    expect(mockDb.appCollaborator.upsert).not.toHaveBeenCalled();
    expect(mockDb.appOwnershipEvent.create).not.toHaveBeenCalled();
  });

  it('inviting the OWNER is INVALID_TARGET', async () => {
    await expect(
      inviteCollaborator({
        appListingId: LISTING,
        targetUserId: OWNER,
        actorUserId: OWNER,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('a nonexistent target is INVALID_TARGET (never a raw FK error)', async () => {
    mockDb.user.findUnique.mockResolvedValue(null);
    await expect(
      inviteCollaborator({ appListingId: LISTING, targetUserId: 999, actorUserId: OWNER, now: NOW })
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('a missing listing is NOT_FOUND', async () => {
    await expect(
      inviteCollaborator({
        appListingId: 'apl_nope',
        targetUserId: TARGET,
        actorUserId: OWNER,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('🔴 a BANNED target cannot be seated (the ban decision)', async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: TARGET, bannedAt: new Date() });
    await expect(
      inviteCollaborator({
        appListingId: LISTING,
        targetUserId: TARGET,
        actorUserId: OWNER,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'BANNED' });
    expect(mockDb.appCollaborator.upsert).not.toHaveBeenCalled();
  });

  /**
   * 🔴 The enforcement point and the picker's screening call must refuse the SAME set. The
   * screen rejected banned, soft-deleted and missing while this selected only `{id, bannedAt}`
   * and let a soft-deleted account through — so the two disagreed and a comment claimed they
   * did not. Refused as NOT FOUND, not as a ban: to anyone outside moderation the account is
   * gone, and a distinct refusal would disclose that it exists.
   */
  it('🔴 a SOFT-DELETED target cannot be seated either, and reads as not-found', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: TARGET,
      bannedAt: null,
      deletedAt: new Date(),
    });
    await expect(
      inviteCollaborator({
        appListingId: LISTING,
        targetUserId: TARGET,
        actorUserId: OWNER,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(mockDb.appCollaborator.upsert).not.toHaveBeenCalled();
  });

  /**
   * The presence half of both refusals: a live account with neither flag IS seatable. Without
   * it, a mutant refusing every target passes the ban and soft-delete cases above.
   */
  it('…while a live target with neither flag is seated', async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: TARGET, bannedAt: null, deletedAt: null });
    await inviteCollaborator({
      appListingId: LISTING,
      targetUserId: TARGET,
      actorUserId: OWNER,
      now: NOW,
    });
    expect(mockDb.appCollaborator.upsert).toHaveBeenCalledTimes(1);
  });

  it('re-inviting an ALREADY ACCEPTED collaborator is ALREADY_SEATED', async () => {
    mockDb.appCollaborator.findUnique.mockResolvedValue({
      status: 'accepted',
      lastNotifiedAt: null,
    });
    await expect(
      inviteCollaborator({
        appListingId: LISTING,
        targetUserId: TARGET,
        actorUserId: OWNER,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'ALREADY_SEATED' });
  });

  it('re-inviting a REJECTED invitee RE-OPENS it as pending (they must consent again)', async () => {
    mockDb.appCollaborator.findUnique.mockResolvedValue({
      status: 'rejected',
      lastNotifiedAt: null,
    });
    const res = await inviteCollaborator({
      appListingId: LISTING,
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
      appListingId: LISTING,
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
      inviteCollaborator({
        appListingId: LISTING,
        targetUserId: TARGET,
        actorUserId: OWNER,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'CAP_REACHED' });
  });

  it('the cap counts PENDING + ACCEPTED only — a rejected row occupies no seat', async () => {
    await inviteCollaborator({
      appListingId: LISTING,
      targetUserId: TARGET,
      actorUserId: OWNER,
      now: NOW,
    });
    const args = mockDb.appCollaborator.count.mock.calls[0][0] as {
      where: { appListingId: string; status: { in: string[] } };
    };
    expect(args.where.status.in.sort()).toEqual(['accepted', 'pending']);
    // …and the cap is per LISTING, not global.
    expect(args.where.appListingId).toBe(LISTING);
  });

  it('the cap is NOT re-charged when re-touching an existing row', async () => {
    mockDb.appCollaborator.findUnique.mockResolvedValue({
      status: 'pending',
      lastNotifiedAt: null,
    });
    mockDb.appCollaborator.count.mockResolvedValue(constants.appCollaborators.maxCollaborators);
    await expect(
      inviteCollaborator({
        appListingId: LISTING,
        targetUserId: TARGET,
        actorUserId: OWNER,
        now: NOW,
      })
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('a notification failure does NOT undo the invite (best-effort, post-commit)', async () => {
    mockNotify.notifyAppCollaborator.mockRejectedValueOnce(new Error('notifications down'));
    await expect(
      inviteCollaborator({
        appListingId: LISTING,
        targetUserId: TARGET,
        actorUserId: OWNER,
        now: NOW,
      })
    ).resolves.toMatchObject({ status: 'pending' });
    expect(mockDb.appCollaborator.upsert).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 🔴 THE SHADOW HAZARD — a seat may only ever exist on a PARENT listing.
// ---------------------------------------------------------------------------

describe('🔴 SHADOW HAZARD — a seat can never be created on a revision draft', () => {
  /**
   * WHY THIS IS A SAFETY GUARD AND NOT A NICETY.
   *
   * `applyApprovedRevision` DELETES the shadow when a moderator approves the revision,
   * and `app_collaborators.app_listing_id` is `ON DELETE CASCADE`. So a seat that landed
   * on a shadow would be destroyed by a routine approve — silently, with no error, and
   * with the audit event still claiming the person was seated. A SQL CHECK cannot
   * express "parent only" (a row-level CHECK cannot see another row's `revision_of_id`),
   * so the invariant is held here and in `resolveListingAccess`'s parent hop.
   *
   * The sibling direction — a seat on the PARENT SURVIVING an approve — is pinned in
   * `app-collaborator.revision-non-clobber.test.ts`.
   */
  it('inviting on a SHADOW is refused, and nothing is written', async () => {
    await expect(
      inviteCollaborator({
        appListingId: SHADOW,
        targetUserId: TARGET,
        actorUserId: OWNER,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(mockDb.appCollaborator.upsert).not.toHaveBeenCalled();
    expect(mockDb.appOwnershipEvent.create).not.toHaveBeenCalled();
  });

  it('🔴 the refusal names the reason (it is a product statement, not an internal error)', async () => {
    await expect(
      inviteCollaborator({
        appListingId: SHADOW,
        targetUserId: TARGET,
        actorUserId: OWNER,
        now: NOW,
      })
    ).rejects.toMatchObject({
      message: 'Collaborators are managed on the live listing, not on a revision draft',
    });
  });

  it('🔴 the refusal fires BEFORE the owner check — the id as SUPPLIED is what is tested', async () => {
    // The guard must not be reachable only via the parent-resolved row: `assertOwner`
    // hops to the parent, so a check placed after it could never see the shadow at all.
    // A STRANGER on a shadow must still get the shadow error, not NOT_OWNER.
    await expect(
      inviteCollaborator({
        appListingId: SHADOW,
        targetUserId: TARGET,
        actorUserId: STRANGER,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('POSITIVE CONTROL: the SAME invite on the shadow’s PARENT succeeds', async () => {
    // Proves the refusal is about the shadow and not about some other fixture defect.
    await expect(
      inviteCollaborator({
        appListingId: LISTING,
        targetUserId: TARGET,
        actorUserId: OWNER,
        now: NOW,
      })
    ).resolves.toMatchObject({ appListingId: LISTING, created: true });
  });

  it('🔴 every OTHER seat mutation handed a shadow id acts on the PARENT’s seat', async () => {
    // Refusing everywhere would break the editor mid-revision; the resolve-to-parent hop
    // is the single path, so these land on the parent rather than on a doomed namespace.
    await respondToInvite({ appListingId: SHADOW, userId: TARGET, accept: true, now: NOW });
    const upd = mockDb.appCollaborator.updateMany.mock.calls[0][0] as {
      where: { appListingId: string };
    };
    expect(upd.where.appListingId).toBe(LISTING);

    mockDb.appCollaborator.deleteMany.mockClear();
    await leaveApp({ appListingId: SHADOW, userId: TARGET });
    const del = mockDb.appCollaborator.deleteMany.mock.calls[0][0] as {
      where: { appListingId: string };
    };
    expect(del.where.appListingId).toBe(LISTING);
  });
});

// ---------------------------------------------------------------------------
// Accept / reject.
// ---------------------------------------------------------------------------

describe('respondToInvite', () => {
  it('ACCEPT flips the row and GRANTS Forgejo write', async () => {
    const res = await respondToInvite({
      appListingId: LISTING,
      userId: TARGET,
      accept: true,
      now: NOW,
    });
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
    const res = await respondToInvite({
      appListingId: LISTING,
      userId: TARGET,
      accept: false,
      now: NOW,
    });
    expect(res.status).toBe('rejected');
    expect(mockRepo.grantAppRepoWrite).not.toHaveBeenCalled();
  });

  it('🔴 no pending invite → NO_INVITE, and NO event is written (tx rolled back)', async () => {
    mockDb.appCollaborator.updateMany.mockResolvedValue({ count: 0 });
    // The real $transaction rolls back on throw; the fake runs inline, so assert on the
    // ORDER instead: the guard must throw BEFORE the event create is reached.
    await expect(
      respondToInvite({ appListingId: LISTING, userId: STRANGER, accept: true, now: NOW })
    ).rejects.toMatchObject({ code: 'NO_INVITE' });
    expect(mockDb.appOwnershipEvent.create).not.toHaveBeenCalled();
    expect(mockRepo.grantAppRepoWrite).not.toHaveBeenCalled();
  });

  it('🔴 a BANNED user cannot ACCEPT', async () => {
    mockDb.user.findUnique.mockResolvedValue({ bannedAt: new Date() });
    await expect(
      respondToInvite({ appListingId: LISTING, userId: TARGET, accept: true, now: NOW })
    ).rejects.toMatchObject({ code: 'BANNED' });
  });

  it('a BANNED user CAN decline (declining takes nothing away from anyone)', async () => {
    mockDb.user.findUnique.mockResolvedValue({ bannedAt: new Date() });
    await expect(
      respondToInvite({ appListingId: LISTING, userId: TARGET, accept: false, now: NOW })
    ).resolves.toMatchObject({ status: 'rejected' });
  });

  // 🔴 The APPEND-ONLY TRAIL's `action` field. Untested until a mutation sweep swapped
  // the ternary and nothing went red: an accept was recorded as a `reject`. The trail is
  // the ONLY record of who consented to what — the seat row itself is deleted on
  // remove/leave — so a silently-inverted action makes the audit history actively
  // misleading rather than merely incomplete, and nothing downstream would ever
  // contradict it.
  it('🔴 ACCEPT is recorded as `accept` in the audit trail', async () => {
    await respondToInvite({ appListingId: LISTING, userId: TARGET, accept: true, now: NOW });
    const evt = mockDb.appOwnershipEvent.create.mock.calls[0][0] as {
      data: { action: string; actorUserId: number; targetUserId: number };
    };
    expect(evt.data.action).toBe('accept');
    expect(evt.data.actorUserId).toBe(TARGET);
    expect(evt.data.targetUserId).toBe(TARGET);
  });

  it('🔴 REJECT is recorded as `reject` — the two are not interchangeable', async () => {
    await respondToInvite({ appListingId: LISTING, userId: TARGET, accept: false, now: NOW });
    const evt = mockDb.appOwnershipEvent.create.mock.calls[0][0] as { data: { action: string } };
    expect(evt.data.action).toBe('reject');
  });

  it('POSITIVE CONTROL: the two branches really do write DIFFERENT actions', async () => {
    // Otherwise both assertions above could be satisfied by one constant string.
    await respondToInvite({ appListingId: LISTING, userId: TARGET, accept: true, now: NOW });
    const a = (mockDb.appOwnershipEvent.create.mock.calls[0][0] as { data: { action: string } })
      .data.action;
    mockDb.appOwnershipEvent.create.mockClear();
    await respondToInvite({ appListingId: LISTING, userId: TARGET, accept: false, now: NOW });
    const b = (mockDb.appOwnershipEvent.create.mock.calls[0][0] as { data: { action: string } })
      .data.action;
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 🔴 KIND × Forgejo — an off-site seat must never reach the repo service.
// ---------------------------------------------------------------------------

describe('🔴 Forgejo is ON-SITE ONLY — the `submitVersion: false` capability, enforced', () => {
  /**
   * An off-site listing has no bundle and no repo. Calling `grantAppRepoWrite` with a
   * store slug that names no repository would be a guaranteed remote 404 on EVERY
   * off-site accept — and because the grant is best-effort post-commit, it would fail
   * silently forever rather than surface. The guard is "there is a backing AppBlock",
   * which is the same fact the capability table encodes.
   */
  it('accepting a seat on an OFF-SITE listing grants NOTHING', async () => {
    const res = await respondToInvite({
      appListingId: OFFSITE,
      userId: TARGET,
      accept: true,
      now: NOW,
    });
    expect(res.status).toBe('accepted');
    expect(mockRepo.grantAppRepoWrite).not.toHaveBeenCalled();
  });

  it('removing an OFF-SITE seat revokes NOTHING', async () => {
    const res = await removeCollaborator({
      appListingId: OFFSITE,
      targetUserId: TARGET,
      actorUserId: OWNER,
    });
    expect(res.removed).toBe(true);
    expect(mockRepo.revokeAppRepoWrite).not.toHaveBeenCalled();
  });

  it('leaving an OFF-SITE listing revokes NOTHING', async () => {
    await leaveApp({ appListingId: OFFSITE, userId: TARGET });
    expect(mockRepo.revokeAppRepoWrite).not.toHaveBeenCalled();
  });

  it('🔴 POSITIVE CONTROL: the SAME three actions on the ON-SITE listing DO reach Forgejo', async () => {
    // Without this, "not called" is indistinguishable from a repo mock that is never
    // called by anything — the classic reassuring zero.
    await respondToInvite({ appListingId: LISTING, userId: TARGET, accept: true, now: NOW });
    expect(mockRepo.grantAppRepoWrite).toHaveBeenCalledWith({ slug: SLUG, userId: TARGET });
    await removeCollaborator({ appListingId: LISTING, targetUserId: TARGET, actorUserId: OWNER });
    expect(mockRepo.revokeAppRepoWrite).toHaveBeenCalledWith({ slug: SLUG, userId: TARGET });
  });

  /**
   * 🔴 THE GATE IS THE **KIND**, NOT THE PRESENCE OF A SLUG.
   *
   * `hasWritableRepo` ANDs two predicates that agree on every ordinary row, so a fixture
   * built only from ordinary rows can be satisfied by either one alone. These three
   * cases put a REAL repo slug on an OFF-SITE listing, so `blockSlug != null` is TRUE and
   * only `listingKindSupports(kind,'submitVersion')` can refuse — which makes them the
   * only cases that can kill a slug-only mutant.
   */
  describe('🔴 an OFF-SITE listing that HAS a repo slug still reaches Forgejo NEVER', () => {
    it('accept grants nothing, even though a slug is available', async () => {
      const res = await respondToInvite({
        appListingId: OFFSITE_WITH_REPO,
        userId: TARGET,
        accept: true,
        now: NOW,
      });
      expect(res.status).toBe('accepted');
      expect(mockRepo.grantAppRepoWrite).not.toHaveBeenCalled();
    });

    it('remove revokes nothing, even though a slug is available', async () => {
      await removeCollaborator({
        appListingId: OFFSITE_WITH_REPO,
        targetUserId: TARGET,
        actorUserId: OWNER,
      });
      expect(mockRepo.revokeAppRepoWrite).not.toHaveBeenCalled();
    });

    it('leave revokes nothing, even though a slug is available', async () => {
      await leaveApp({ appListingId: OFFSITE_WITH_REPO, userId: TARGET });
      expect(mockRepo.revokeAppRepoWrite).not.toHaveBeenCalled();
    });

    it('🔴 POSITIVE CONTROL: THAT EXACT SLUG does reach Forgejo once the kind is onsite', async () => {
      // Without this, "not called" is indistinguishable from a fixture whose slug was
      // never reachable — the same zero, two causes. Only `kind` changes here.
      LISTINGS[OFFSITE_WITH_REPO] = { ...LISTINGS[OFFSITE_WITH_REPO], kind: 'onsite' };
      await respondToInvite({
        appListingId: OFFSITE_WITH_REPO,
        userId: TARGET,
        accept: true,
        now: NOW,
      });
      expect(mockRepo.grantAppRepoWrite).toHaveBeenCalledWith({
        slug: OFFSITE_REPO_SLUG,
        userId: TARGET,
      });
    });
  });

  /**
   * 🔴 THE NULL-SLUG HALF — the clause the COMPILER cannot hold.
   *
   * `hasWritableRepo` is a type PREDICATE, and an earlier comment on it claimed that
   * relaxing its body to a kind-only check "is a type error at every call site instead".
   * It is not: TypeScript never checks a user-defined predicate's body against the
   * declared predicate. Measured with `pnpm typecheck` on this tree — the relaxed body
   * emits 0 errors; the positive control (same body, return type demoted to `boolean`)
   * emits exactly 3 `TS2322: Type 'string | null' is not assignable to type 'string'`,
   * one per call site.
   *
   * So the null half is held HERE or nowhere. Every other on-site fixture in this file
   * carries a slug, which means both clauses agree on it and either alone satisfies it;
   * this row is the only one that can kill a body relaxed to `listingKindSupports(...)`
   * — the kind says `submitVersion: true`, so only `blockSlug != null` can refuse, and
   * a mutant would call Forgejo with `null` as the repository name.
   */
  describe('🔴 an ON-SITE listing with NO backing block reaches Forgejo NEVER', () => {
    it('accept grants nothing — there is no repo to grant on', async () => {
      const res = await respondToInvite({
        appListingId: ONSITE_NO_BLOCK,
        userId: TARGET,
        accept: true,
        now: NOW,
      });
      expect(res.status).toBe('accepted');
      expect(mockRepo.grantAppRepoWrite).not.toHaveBeenCalled();
    });

    it('remove revokes nothing', async () => {
      await removeCollaborator({
        appListingId: ONSITE_NO_BLOCK,
        targetUserId: TARGET,
        actorUserId: OWNER,
      });
      expect(mockRepo.revokeAppRepoWrite).not.toHaveBeenCalled();
    });

    it('leave revokes nothing', async () => {
      await leaveApp({ appListingId: ONSITE_NO_BLOCK, userId: TARGET });
      expect(mockRepo.revokeAppRepoWrite).not.toHaveBeenCalled();
    });

    it('🔴 POSITIVE CONTROL: the SAME row reaches Forgejo once it has a block', async () => {
      // Without this, "not called" is indistinguishable from a fixture this path never
      // reaches at all — the reassuring zero. Only the block changes here; the kind was
      // already `onsite`, so this also proves the kind clause was never what refused.
      LISTINGS[ONSITE_NO_BLOCK] = {
        ...LISTINGS[ONSITE_NO_BLOCK],
        appBlockId: 'ab_late',
        appBlock: { appId: 'oc_late', blockId: 'late-repo', app: { userId: OWNER } },
      };
      await respondToInvite({
        appListingId: ONSITE_NO_BLOCK,
        userId: TARGET,
        accept: true,
        now: NOW,
      });
      expect(mockRepo.grantAppRepoWrite).toHaveBeenCalledWith({
        slug: 'late-repo',
        userId: TARGET,
      });
    });
  });

  it('🔴 the repo slug is the BLOCK slug, not the store slug', async () => {
    // They coincide for on-site listings today, so the fixture makes them differ to
    // prove which one is actually read: the Forgejo repo is `civitai-apps/<blockId>`.
    LISTINGS[LISTING] = {
      ...LISTINGS[LISTING],
      slug: 'store-facing-slug',
      appBlock: { appId: 'oc_app1', blockId: 'repo-slug', app: { userId: OWNER } },
    };
    await respondToInvite({ appListingId: LISTING, userId: TARGET, accept: true, now: NOW });
    expect(mockRepo.grantAppRepoWrite).toHaveBeenCalledWith({ slug: 'repo-slug', userId: TARGET });
  });
});

// ---------------------------------------------------------------------------
// Remove / leave.
// ---------------------------------------------------------------------------

describe('removeCollaborator / leaveApp — the REVOKE half', () => {
  it('the owner removes a seat and the repo grant is REVOKED', async () => {
    const res = await removeCollaborator({
      appListingId: LISTING,
      targetUserId: TARGET,
      actorUserId: OWNER,
    });
    expect(res.removed).toBe(true);
    expect(mockRepo.revokeAppRepoWrite).toHaveBeenCalledWith({ slug: SLUG, userId: TARGET });
  });

  it('a NON-OWNER cannot remove someone else', async () => {
    await expect(
      removeCollaborator({ appListingId: LISTING, targetUserId: TARGET, actorUserId: STRANGER })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
    expect(mockRepo.revokeAppRepoWrite).not.toHaveBeenCalled();
  });

  it('removing a seat that does not exist is a no-op and revokes nothing', async () => {
    mockDb.appCollaborator.deleteMany.mockResolvedValue({ count: 0 });
    const res = await removeCollaborator({
      appListingId: LISTING,
      targetUserId: TARGET,
      actorUserId: OWNER,
    });
    expect(res.removed).toBe(false);
    expect(mockRepo.revokeAppRepoWrite).not.toHaveBeenCalled();
    expect(mockDb.appOwnershipEvent.create).not.toHaveBeenCalled();
  });

  it('a COLLABORATOR may leave without any owner check — and is revoked', async () => {
    const res = await leaveApp({ appListingId: LISTING, userId: TARGET });
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
   * give up my seat" into "every collaborator on this listing is removed" — a one-word
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
  let seats: Array<{ appListingId: string; userId: number }>;

  beforeEach(() => {
    seats = [
      { appListingId: LISTING, userId: TARGET },
      { appListingId: LISTING, userId: OTHER_SEAT },
      // A seat on a DIFFERENT listing, so an over-broad `where` that keeps `userId` but
      // drops `appListingId` is caught too.
      { appListingId: OFFSITE, userId: TARGET },
    ];
    mockDb.appCollaborator.deleteMany.mockImplementation(async (args: unknown) => {
      const w = (args as { where: { appListingId?: string; userId?: number } }).where;
      const before = seats.length;
      seats = seats.filter(
        (s) =>
          !(
            (w.appListingId === undefined || s.appListingId === w.appListingId) &&
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

  it('🔴 leaveApp removes ONLY the caller’s seat on THIS listing', async () => {
    const res = await leaveApp({ appListingId: LISTING, userId: TARGET });
    expect(res.removed).toBe(true);
    // The co-editor keeps their seat. A `where` missing `userId` deletes them too.
    expect(seats).toContainEqual({ appListingId: LISTING, userId: OTHER_SEAT });
    // …and the caller's seat on an unrelated listing survives. A `where` missing
    // `appListingId` takes that one.
    expect(seats).toContainEqual({ appListingId: OFFSITE, userId: TARGET });
    expect(seats).not.toContainEqual({ appListingId: LISTING, userId: TARGET });
    expect(seats).toHaveLength(2);
  });

  it('🔴 leaveApp revokes repo write for the LEAVER only', async () => {
    await leaveApp({ appListingId: LISTING, userId: TARGET });
    expect(mockRepo.revokeAppRepoWrite).toHaveBeenCalledOnce();
    expect(mockRepo.revokeAppRepoWrite).toHaveBeenCalledWith({ slug: SLUG, userId: TARGET });
  });

  it('🔴 removeCollaborator removes ONLY the named target', async () => {
    await removeCollaborator({ appListingId: LISTING, targetUserId: TARGET, actorUserId: OWNER });
    expect(seats).toContainEqual({ appListingId: LISTING, userId: OTHER_SEAT });
    expect(seats).not.toContainEqual({ appListingId: LISTING, userId: TARGET });
  });

  it('leaving a listing you hold no seat on removes nothing and revokes nothing', async () => {
    const res = await leaveApp({ appListingId: LISTING, userId: STRANGER });
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
        inviteCollaborator({
          appListingId: LISTING,
          targetUserId: TARGET,
          actorUserId: OWNER,
          now: NOW,
        }),
      'invite',
    ],
    [
      'respondToInvite',
      () => respondToInvite({ appListingId: LISTING, userId: TARGET, accept: true, now: NOW }),
      'accept',
    ],
    [
      'removeCollaborator',
      () => removeCollaborator({ appListingId: LISTING, targetUserId: TARGET, actorUserId: OWNER }),
      'remove',
    ],
    ['leaveApp', () => leaveApp({ appListingId: LISTING, userId: TARGET }), 'leave'],
    [
      'setCollaboratorDisplayed',
      () => setCollaboratorDisplayed({ appListingId: LISTING, userId: TARGET, displayed: true }),
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
    await respondToInvite({ appListingId: LISTING, userId: TARGET, accept: true, now: NOW });
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
      appListingId: LISTING,
      userId: TARGET,
      displayed: false,
    });
    expect(res.displayed).toBe(false);
    const upd = mockDb.appCollaborator.updateMany.mock.calls[0][0] as {
      where: { status: string; appListingId: string };
      data: { displayed: boolean };
    };
    // 🔴 Guarded on ACCEPTED: a pending invitee must not be able to pre-arrange public
    // credit for a seat they have not taken.
    expect(upd.where.status).toBe('accepted');
    expect(upd.where.appListingId).toBe(LISTING);
    expect(upd.data.displayed).toBe(false);
  });

  it('a non-accepted (or absent) row is refused', async () => {
    mockDb.appCollaborator.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      setCollaboratorDisplayed({ appListingId: LISTING, userId: STRANGER, displayed: true })
    ).rejects.toMatchObject({ code: 'NO_INVITE' });
  });

  it('an OFF-SITE collaborator can toggle their byline too', async () => {
    // The byline is the one collaborator surface that is fully public, and it is
    // kind-agnostic — an off-site listing's detail page carries the same chips.
    await expect(
      setCollaboratorDisplayed({ appListingId: OFFSITE, userId: TARGET, displayed: false })
    ).resolves.toMatchObject({ appListingId: OFFSITE, displayed: false });
  });
});

// ---------------------------------------------------------------------------
// Byline — OWNER control over someone else's seat.
// ---------------------------------------------------------------------------

/**
 * 🔴 A DELIBERATE PRODUCT DECISION, not an emergent capability: the app OWNER may set a
 * collaborator's `displayed` flag, which means an owner can remove a collaborator's
 * public credit without removing their seat.
 *
 * The narrower alternative — `displayed` as a purely self-service preference belonging to
 * the person named — was implemented first and explicitly overruled. It is recorded here
 * because the code alone cannot distinguish "decided" from "not yet noticed", and the
 * ledger of who may touch a public-credit flag is exactly the thing a later reader will
 * want to know was chosen on purpose.
 *
 * SELF-SERVICE IS UNCHANGED AND STILL PRESENT: `targetUserId` is OPTIONAL, and omitting
 * it means "my own row" — the shape the proc already shipped with. This widens, it does
 * not replace, which is the only safe direction for an already-deployed input schema.
 */
describe('setCollaboratorDisplayed — OWNER control (targetUserId)', () => {
  it('the OWNER may set ANOTHER seat’s flag, and the write targets that seat', async () => {
    const res = await setCollaboratorDisplayed({
      appListingId: LISTING,
      userId: OWNER,
      targetUserId: TARGET,
      displayed: false,
    });
    expect(res).toMatchObject({ appListingId: LISTING, userId: TARGET, displayed: false });
    const upd = mockDb.appCollaborator.updateMany.mock.calls[0][0] as {
      where: { userId: number; status: string };
      data: { displayed: boolean };
    };
    // 🔴 The TARGET's row, not the caller's — the mutant that "works" by ignoring
    // targetUserId would silently flip the owner's own (nonexistent) seat instead.
    expect(upd.where.userId).toBe(TARGET);
    // The ACCEPTED guard survives owner control: an owner cannot pre-arrange credit for
    // a pending invitee either.
    expect(upd.where.status).toBe('accepted');
    expect(upd.data.displayed).toBe(false);
  });

  it('the audit event records the OWNER as actor and the collaborator as target', async () => {
    await setCollaboratorDisplayed({
      appListingId: LISTING,
      userId: OWNER,
      targetUserId: TARGET,
      displayed: false,
    });
    const evt = mockDb.appOwnershipEvent.create.mock.calls[0][0] as {
      data: { action: string; actorUserId: number; targetUserId: number };
    };
    expect(evt.data.action).toBe('display');
    expect(evt.data.actorUserId).toBe(OWNER);
    expect(evt.data.targetUserId).toBe(TARGET);
  });

  /**
   * 🔴 THE CASE MOST LIKELY TO BE WRONG. An accepted EDITOR holds a seat, so any gate
   * that asks "does the caller have a role here?" instead of "is the caller the OWNER?"
   * lets them through — and they would then be able to strip a PEER's public credit.
   */
  it('a non-owner ACCEPTED EDITOR may NOT set another seat’s flag', async () => {
    await expect(
      setCollaboratorDisplayed({
        appListingId: LISTING,
        userId: SECOND_SEAT,
        targetUserId: TARGET,
        displayed: false,
      })
    ).rejects.toMatchObject({ code: 'NOT_OWNER', message: BYLINE_NOT_OWNER_MESSAGE });
    expect(mockDb.appCollaborator.updateMany).not.toHaveBeenCalled();
  });

  it('a STRANGER may NOT set another seat’s flag', async () => {
    await expect(
      setCollaboratorDisplayed({
        appListingId: LISTING,
        userId: STRANGER,
        targetUserId: TARGET,
        displayed: true,
      })
    ).rejects.toMatchObject({ code: 'NOT_OWNER', message: BYLINE_NOT_OWNER_MESSAGE });
    expect(mockDb.appCollaborator.updateMany).not.toHaveBeenCalled();
  });

  it('a MODERATOR may set another seat’s flag — granted, and pinned so', async () => {
    // Consistent with `listCollaborators`, which already admits a moderator to the full
    // roster INCLUDING `displayed:false` seats. A public byline is moderatable content.
    await expect(
      setCollaboratorDisplayed({
        appListingId: LISTING,
        userId: STRANGER,
        targetUserId: TARGET,
        displayed: false,
        isModerator: true,
      })
    ).resolves.toMatchObject({ userId: TARGET, displayed: false });
  });

  it('SELF-SERVICE survives: a plain collaborator with NO targetUserId still works', async () => {
    const res = await setCollaboratorDisplayed({
      appListingId: LISTING,
      userId: TARGET,
      displayed: false,
    });
    expect(res.userId).toBe(TARGET);
    const upd = mockDb.appCollaborator.updateMany.mock.calls[0][0] as {
      where: { userId: number };
    };
    expect(upd.where.userId).toBe(TARGET);
  });

  it('SELF-SERVICE survives when targetUserId names the CALLER explicitly', async () => {
    // A client that always sends the field must not accidentally require ownership.
    await expect(
      setCollaboratorDisplayed({
        appListingId: LISTING,
        userId: TARGET,
        targetUserId: TARGET,
        displayed: true,
      })
    ).resolves.toMatchObject({ userId: TARGET, displayed: true });
  });

  /**
   * 🔴 OWNERSHIP MUST RESOLVE CANONICALLY — `AppBlock.app.userId`, not the denormalized
   * `AppListing.userId`. Both directions on the SAME drifted row, because a gate that
   * reads the column fails BOTH ways at once: it refuses the real owner on their own app
   * AND admits whoever the stale row happens to name.
   */
  describe('on a DRIFTED on-site listing', () => {
    it('the REAL (canonical) owner is admitted', async () => {
      await expect(
        setCollaboratorDisplayed({
          appListingId: DRIFTED,
          userId: OWNER,
          targetUserId: TARGET,
          displayed: false,
        })
      ).resolves.toMatchObject({ userId: TARGET, displayed: false });
    });

    it('the STALE denormalized name is REFUSED', async () => {
      await expect(
        setCollaboratorDisplayed({
          appListingId: DRIFTED,
          userId: STALE_OWNER,
          targetUserId: TARGET,
          displayed: false,
        })
      ).rejects.toMatchObject({ code: 'NOT_OWNER', message: BYLINE_NOT_OWNER_MESSAGE });
      expect(mockDb.appCollaborator.updateMany).not.toHaveBeenCalled();
    });
  });

  /**
   * 🔴 ISSUE #3844 — the OFF-SITE mirror image, and the one `toSeatListing` got wrong.
   *
   * On an off-site listing the column IS the owner and the attached block must NOT
   * override it. `toSeatListing` resolved block-first, so on this row seat MANAGEMENT
   * answered to whoever the block named — i.e. the ex-owner, or the impersonator a
   * moderator had just dispossessed with `claimListing`, since both off-site ownership
   * writers move only the column.
   */
  describe('on an OFF-SITE listing that CARRIES A BLOCK (#3844)', () => {
    it('POSITIVE CONTROL: the fixture is offsite, has a block, and the two owners differ', async () => {
      const row = (await mockDb.appListing.findUnique({
        where: { id: OFFSITE_BLOCK_DRIFTED },
      })) as { kind: string; userId: number; appBlock: { app: { userId: number } } };
      expect(row.kind).toBe('offsite');
      expect(row.userId).toBe(OWNER);
      expect(row.appBlock.app.userId).toBe(STRANGER);
      expect(OWNER).not.toBe(STRANGER);
    });

    it('the COLUMN owner may manage seats', async () => {
      await expect(
        setCollaboratorDisplayed({
          appListingId: OFFSITE_BLOCK_DRIFTED,
          userId: OWNER,
          targetUserId: TARGET,
          displayed: false,
        })
      ).resolves.toMatchObject({ userId: TARGET, displayed: false });
    });

    it('🔴 the user the BLOCK names is REFUSED — and writes nothing', async () => {
      await expect(
        setCollaboratorDisplayed({
          appListingId: OFFSITE_BLOCK_DRIFTED,
          userId: STRANGER,
          targetUserId: TARGET,
          displayed: false,
        })
      ).rejects.toMatchObject({ code: 'NOT_OWNER', message: BYLINE_NOT_OWNER_MESSAGE });
      expect(mockDb.appCollaborator.updateMany).not.toHaveBeenCalled();
    });
  });

  /**
   * 🔴 TWO ASSERTIONS THAT CLOSE SURVIVED MUTANTS. Both lines were added by this feature
   * and both survived the first mutation sweep — i.e. they were unpinned behaviour that
   * looked pinned because the surrounding tests were green.
   */
  it('the NO_INVITE message names the TARGET when an owner acts on someone else', async () => {
    // Self and owner-driven failures are different situations: "you are not an active
    // collaborator" is simply wrong copy to show an owner who picked a stale row.
    mockDb.appCollaborator.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      setCollaboratorDisplayed({
        appListingId: LISTING,
        userId: OWNER,
        targetUserId: TARGET,
        displayed: false,
      })
    ).rejects.toMatchObject({
      code: 'NO_INVITE',
      message: 'That user is not an active collaborator on this app',
    });
  });

  it('…and keeps the SELF wording on the self path', async () => {
    mockDb.appCollaborator.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      setCollaboratorDisplayed({ appListingId: LISTING, userId: TARGET, displayed: false })
    ).rejects.toMatchObject({
      code: 'NO_INVITE',
      message: 'You are not an active collaborator on this app',
    });
  });

  it('the audit metadata records `byOwner` — the two paths are distinguishable', async () => {
    // Without it the log cannot tell an owner un-crediting a collaborator from the
    // collaborator opting out, which is the one question this event exists to answer.
    await setCollaboratorDisplayed({
      appListingId: LISTING,
      userId: OWNER,
      targetUserId: TARGET,
      displayed: false,
    });
    const owned = mockDb.appOwnershipEvent.create.mock.calls[0][0] as {
      data: { metadata: { byOwner: boolean; displayed: boolean } };
    };
    expect(owned.data.metadata.byOwner).toBe(true);
    expect(owned.data.metadata.displayed).toBe(false);

    vi.clearAllMocks();
    mockDb.appCollaborator.updateMany.mockResolvedValue({ count: 1 });
    await setCollaboratorDisplayed({ appListingId: LISTING, userId: TARGET, displayed: true });
    const self = mockDb.appOwnershipEvent.create.mock.calls[0][0] as {
      data: { metadata: { byOwner: boolean } };
    };
    expect(self.data.metadata.byOwner).toBe(false);
  });

  it('an OFF-SITE listing’s owner may set a seat’s flag — the column IS canonical there', async () => {
    // The control that keeps the canonical resolution from over-reaching: an off-site
    // listing has no OauthClient in its ownership chain, so `AppListing.userId` is the
    // owner and must still be honoured.
    await expect(
      setCollaboratorDisplayed({
        appListingId: OFFSITE,
        userId: OWNER,
        targetUserId: TARGET,
        displayed: false,
      })
    ).resolves.toMatchObject({ appListingId: OFFSITE, userId: TARGET, displayed: false });
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
   * `resolveListingAccess` was consulted here only for `ownerUserId`; its `role` was
   * never required non-null. The status filter governs which ROWS a viewer sees, not
   * whether the viewer may read the listing at all — so any account with the author flag
   * could enumerate ANY listing's accepted roster, INCLUDING seats whose holder set
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
      listCollaborators({ appListingId: LISTING, viewerUserId: OWNER, isModerator: false })
    ).resolves.toHaveLength(1);
  });

  it('an ACCEPTED editor may read the roster', async () => {
    mockDb.appCollaborator.findFirst.mockResolvedValue({ userId: TARGET });
    await expect(
      listCollaborators({ appListingId: LISTING, viewerUserId: TARGET, isModerator: false })
    ).resolves.toHaveLength(1);
  });

  it('a MODERATOR may read the roster', async () => {
    await expect(
      listCollaborators({ appListingId: LISTING, viewerUserId: STRANGER, isModerator: true })
    ).resolves.toHaveLength(1);
  });

  it('🔴 a STRANGER is refused — and the query never runs', async () => {
    await expect(
      listCollaborators({ appListingId: LISTING, viewerUserId: STRANGER, isModerator: false })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
    // Fail BEFORE the read, not after it: the rows must never be loaded, let alone
    // filtered.
    expect(mockDb.appCollaborator.findMany).not.toHaveBeenCalled();
  });

  it('🔴 an ANONYMOUS caller is refused', async () => {
    await expect(
      listCollaborators({ appListingId: LISTING, viewerUserId: null, isModerator: false })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
  });

  it('🔴 a PENDING invitee is refused (they read their own invite via listMyPendingInvites)', async () => {
    // `resolveListingAccess` returns role null for a pending seat — the consent rule. So
    // a pending invitee does not get the listing's roster as a side effect of being
    // invited.
    mockDb.appCollaborator.findFirst.mockImplementation(async (args: unknown) => {
      const w = (args as { where: { status?: string } }).where;
      return w.status === 'accepted' ? null : { userId: TARGET };
    });
    await expect(
      listCollaborators({ appListingId: LISTING, viewerUserId: TARGET, isModerator: false })
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
  });

  it('a missing listing is NOT_FOUND, distinct from a refusal', async () => {
    await expect(
      listCollaborators({ appListingId: 'apl_nope', viewerUserId: OWNER, isModerator: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the OFF-SITE owner may read their roster', async () => {
    await expect(
      listCollaborators({ appListingId: OFFSITE, viewerUserId: OWNER, isModerator: false })
    ).resolves.toHaveLength(1);
  });

  it('🔴 opening the roster from a SHADOW reads the PARENT’s seats, not an empty set', async () => {
    await listCollaborators({ appListingId: SHADOW, viewerUserId: OWNER, isModerator: false });
    expect(mockDb.appCollaborator.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { appListingId: LISTING } })
    );
  });

  /**
   * 🔴 THE ROSTER GATE MUST USE THE **CANONICAL** OWNER.
   *
   * `listCollaborators` routes through `resolveListingAccess`. On `origin/main` this
   * gate went through `resolveAppAccess`, whose owner is the canonical
   * `AppBlock.app.userId`; the re-key moved it to the listing resolver, and while that
   * resolver read `AppListing.userId` the gate silently changed authority to a
   * DENORMALIZED COPY the feature's own transfer path can leave stale.
   *
   * Both directions are pinned, because the regression inverts the gate rather than
   * merely loosening it: the REAL owner is refused NOT_OWNER on their own roster, and
   * whoever the stale row names reads the full roster — including `displayed:false`
   * seats, `invitedBy` and the invite/response timestamps.
   */
  describe('🔴 the owner gate is CANONICAL, not the denormalized AppListing.userId', () => {
    it('POSITIVE CONTROL: the DRIFTED fixture really does disagree with itself', async () => {
      const row = (await mockDb.appListing.findUnique({ where: { id: DRIFTED } })) as {
        userId: number;
        appBlock: { app: { userId: number } };
      };
      expect(row.userId).toBe(STALE_OWNER);
      expect(row.appBlock.app.userId).toBe(OWNER);
      expect(row.userId).not.toBe(row.appBlock.app.userId);
    });

    it('🔴 the REAL owner reads their own roster on a drifted listing', async () => {
      await expect(
        listCollaborators({ appListingId: DRIFTED, viewerUserId: OWNER, isModerator: false })
      ).resolves.toHaveLength(1);
    });

    it('🔴 the STALE user is refused NOT_OWNER — and the rows are never loaded', async () => {
      await expect(
        listCollaborators({ appListingId: DRIFTED, viewerUserId: STALE_OWNER, isModerator: false })
      ).rejects.toMatchObject({ code: 'NOT_OWNER' });
      // Fail BEFORE the read: the opted-out seats must not even be fetched.
      expect(mockDb.appCollaborator.findMany).not.toHaveBeenCalled();
    });
  });

  it('POSITIVE CONTROL: the roster fixture really carries an opted-OUT seat', async () => {
    // The stake of the leak, stated as data: `displayed: false` is exactly the row a
    // stranger must not be able to read back.
    const rows = await listCollaborators({
      appListingId: LISTING,
      viewerUserId: OWNER,
      isModerator: false,
    });
    expect(rows[0].displayed).toBe(false);
    expect(rows[0].invitedBy).toBe(OWNER);
  });
});

// ---------------------------------------------------------------------------
// The invitee's inbox.
// ---------------------------------------------------------------------------

describe('listMyPendingInvites', () => {
  it('carries the listing identity AND its kind, so the client can render both kinds', async () => {
    mockDb.appCollaborator.findMany.mockResolvedValue([
      {
        appListingId: LISTING,
        invitedBy: OWNER,
        createdAt: NOW,
        appListing: { slug: SLUG, kind: 'onsite', appBlockId: APP },
      },
      {
        appListingId: OFFSITE,
        invitedBy: OWNER,
        createdAt: NOW,
        appListing: { slug: OFFSITE_SLUG, kind: 'offsite', appBlockId: null },
      },
    ]);
    expect(await listMyPendingInvites(TARGET)).toEqual([
      {
        appListingId: LISTING,
        slug: SLUG,
        kind: 'onsite',
        appBlockId: APP,
        invitedBy: OWNER,
        createdAt: NOW,
      },
      {
        appListingId: OFFSITE,
        slug: OFFSITE_SLUG,
        kind: 'offsite',
        appBlockId: null,
        invitedBy: OWNER,
        createdAt: NOW,
      },
    ]);
  });

  it('only PENDING rows are read', async () => {
    mockDb.appCollaborator.findMany.mockResolvedValue([]);
    await listMyPendingInvites(TARGET);
    expect(mockDb.appCollaborator.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: TARGET, status: 'pending' } })
    );
  });
});
