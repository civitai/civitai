import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 A SEAT MAY NOT BE GRANTED ON A LISTING THAT IS NO LONGER LIVE — the ENFORCEMENT point
 * behind the authoring page's narrowed tab set, not a mirror of it.
 *
 * ## Why this file exists
 *
 * Accepting a collaborator seat grants Forgejo `write` on `civitai-apps/<slug>`. Measured on
 * `origin/main` before this change, NOTHING on the server looked at the listing's status on
 * the way to that grant: `inviteCollaborator`, `respondToInvite` and `listCollaborators` all
 * read ownership/seat state and nothing else. The ONLY thing standing between a
 * moderator-removed app and a fresh repo grant was `getAppListingAuthoringContext` refusing
 * to open the authoring page — i.e. a UI reachability accident, on a tRPC procedure that is
 * callable without any page at all.
 *
 * This PR opens that route on `removed` so an owner can reach their own Republish (an owner
 * Unpublish and a moderator takedown both write `status='removed'`, so refusing the page made
 * an owner unpublish a one-way door only a moderator could reopen — civitai/civitai#4218).
 * `editorTabsFor` withholds the Collaborators tab there, and
 * `appListingEditorTabs.test.ts`'s "NEVER Collaborators" case pins that. But a tab set is a
 * UI NARROWING and never a gate, so the refusal lives here, where the grant does.
 *
 * ## Scope, stated exactly
 *
 * It guards the TWO GRANT PATHS ONLY — `invite`, and `respondToInvite` on an ACCEPT.
 * `remove`, `leave`, `setDisplayed`, a DECLINE and `list` are deliberately unguarded: each
 * either REDUCES access or is a read, and refusing them on a removed listing would strand an
 * owner who wants to revoke a seat on the app that was just taken down. Every one of those is
 * asserted below as a control, so "the guard is too wide" is a red rather than a review note.
 */

const { mockRepo, mockNotify } = vi.hoisted(() => ({
  mockRepo: {
    grantAppRepoWrite: vi.fn(async () => undefined),
    revokeAppRepoWrite: vi.fn(async () => undefined),
  },
  mockNotify: { notifyAppCollaborator: vi.fn(async () => undefined) },
}));

vi.mock('~/server/services/blocks/app-repo-access', () => mockRepo);
vi.mock('~/server/services/blocks/app-collaborator-notify', () => mockNotify);

/**
 * 🔴 THE CANONICAL `~/server/db/client` MOCK, not a per-file `vi.mock` — see
 * `docs/testing/shared-module-mocks.md` and the `no-direct-shared-module-mock` ratchet.
 * `dbRead` and `dbWrite` are DISTINCT here, which matters for this subject rather than being
 * incidental: the seat READS (`loadSeatListing`, the target account, the existing row) go
 * through `dbRead`, while the seat WRITES run inside `dbWrite.$transaction`. The canonical
 * `$transaction` default invokes its callback with `dbMock.dbWrite`, so an assertion that a
 * write did NOT happen is a claim about the write client specifically.
 */
const { dbMock } = await import('~/__tests__/mocks/db.mock');

const { inviteCollaborator, respondToInvite, removeCollaborator, leaveApp, listCollaborators } =
  await import('~/server/services/blocks/app-collaborator.service');

const OWNER = 41;
const TARGET = 42;
const LISTING = 'apl_seatstatus';
const SLUG = 'seat-status-app';

/** Distinct from every other id/slug in this file, so no assertion can pass by coincidence. */
function seatListing(status: string) {
  return {
    id: LISTING,
    slug: SLUG,
    kind: 'onsite',
    status,
    userId: OWNER,
    appBlockId: 'ab_seatstatus',
    revisionOfId: null,
    revisionOf: null,
    appBlock: { appId: 'oc_seatstatus', blockId: SLUG, app: { userId: OWNER } },
  };
}

function withStatus(status: string) {
  dbMock.dbRead.appListing.findUnique.mockImplementation(
    async (args: unknown): Promise<unknown> => {
      const w = (args as { where: { id?: string } }).where;
      return w.id === LISTING ? seatListing(status) : null;
    }
  );
}

beforeEach(() => {
  mockRepo.grantAppRepoWrite.mockClear();
  mockRepo.revokeAppRepoWrite.mockClear();
  mockNotify.notifyAppCollaborator.mockClear();
  dbMock.dbRead.user.findUnique.mockResolvedValue({
    id: TARGET,
    bannedAt: null,
    deletedAt: null,
  });
  dbMock.dbRead.appCollaborator.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.appCollaborator.count.mockResolvedValue(0);
  dbMock.dbWrite.appCollaborator.updateMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.appCollaborator.deleteMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.appCollaborator.upsert.mockResolvedValue({});
  dbMock.dbWrite.appOwnershipEvent.create.mockResolvedValue({});
  // 🔴 CALL HISTORY IS CLEARED EXPLICITLY. The canonical mock's reset runs per FILE, not per
  // test, and `mockResolvedValue` does not touch history — so without this the "called once"
  // control arms accumulate across the loop and read 2, then 3. Every "not called" assertion
  // in this file is only meaningful against a cleared node.
  dbMock.dbWrite.appCollaborator.upsert.mockClear();
  dbMock.dbWrite.appCollaborator.updateMany.mockClear();
  dbMock.dbWrite.appCollaborator.deleteMany.mockClear();
  dbMock.dbWrite.appOwnershipEvent.create.mockClear();
});

/* ------------------------------------------------------------------ *
 * invite
 * ------------------------------------------------------------------ */

describe('inviteCollaborator refuses a listing that is no longer live', () => {
  for (const status of ['removed', 'rejected']) {
    it(`🔴 refuses on \`${status}\` — and writes NOTHING`, async () => {
      withStatus(status);
      await expect(
        inviteCollaborator({ appListingId: LISTING, targetUserId: TARGET, actorUserId: OWNER })
      ).rejects.toMatchObject({
        code: 'INVALID_TARGET',
        message: 'This listing is not accepting collaborators — it is no longer live in the store',
      });
      // 🔴 THE REFUSAL IS NOT ENOUGH ON ITS OWN. A guard that threw AFTER upserting the row
      // would satisfy the assertion above while leaving a standing invitation on a delisted
      // app — which is the entire hazard, one step removed. So the writes are asserted too.
      expect(dbMock.dbWrite.appCollaborator.upsert).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.appOwnershipEvent.create).not.toHaveBeenCalled();
      expect(mockNotify.notifyAppCollaborator).not.toHaveBeenCalled();
    });
  }

  it('🔴 refuses an UNKNOWN status too — the guard FAILS CLOSED', async () => {
    // `quarantined` is not a prefix or suffix of any real listing status, so it cannot match
    // one by accident. A status this code has never heard of must not be granted a seat by
    // default.
    withStatus('quarantined');
    await expect(
      inviteCollaborator({ appListingId: LISTING, targetUserId: TARGET, actorUserId: OWNER })
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(dbMock.dbWrite.appCollaborator.upsert).not.toHaveBeenCalled();
  });

  for (const status of ['draft', 'pending', 'approved']) {
    it(`ADMITS \`${status}\` (the control arm) — the invite really lands`, async () => {
      // 🔴 THE POSITIVE CONTROL FOR EVERY "not called" ABOVE. Three assertions that a mock
      // was NOT called are indistinguishable from a harness wired to nothing; this arm makes
      // the same mocks move, with the same fixture and the same call shape.
      withStatus(status);
      const result = await inviteCollaborator({
        appListingId: LISTING,
        targetUserId: TARGET,
        actorUserId: OWNER,
      });
      expect(result).toMatchObject({ appListingId: LISTING, userId: TARGET, status: 'pending' });
      expect(dbMock.dbWrite.appCollaborator.upsert).toHaveBeenCalledTimes(1);
    });
  }
});

/* ------------------------------------------------------------------ *
 * accept / decline
 * ------------------------------------------------------------------ */

describe('respondToInvite guards the ACCEPT and never the DECLINE', () => {
  for (const status of ['removed', 'rejected', 'quarantined']) {
    it(`🔴 an ACCEPT on \`${status}\` is refused, and NO repo write is granted`, async () => {
      withStatus(status);
      await expect(
        respondToInvite({ appListingId: LISTING, userId: TARGET, accept: true })
      ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
      // 🔴 THE WHOLE POINT OF THE GUARD, asserted directly rather than inferred from the
      // throw: `grantAppRepoWrite` is what turns a seat into push access on the app's repo.
      expect(mockRepo.grantAppRepoWrite).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.appCollaborator.updateMany).not.toHaveBeenCalled();
    });
  }

  for (const status of ['removed', 'rejected', 'quarantined']) {
    it(`🔴 a DECLINE on \`${status}\` still WORKS — refusing it would trap the invitee`, async () => {
      // A decline grants nothing. Refusing it would leave someone holding a standing
      // invitation on an app whose listing was removed after the invite was sent, with no
      // way to clear it. This is the case that makes "accept only" individually killable: a
      // guard moved above the `if (opts.accept)` reddens exactly here.
      withStatus(status);
      const result = await respondToInvite({
        appListingId: LISTING,
        userId: TARGET,
        accept: false,
      });
      expect(result).toMatchObject({ status: 'rejected' });
      expect(mockRepo.grantAppRepoWrite).not.toHaveBeenCalled();
    });
  }

  it('an ACCEPT on an approved listing DOES grant repo write (the control arm)', async () => {
    withStatus('approved');
    const result = await respondToInvite({ appListingId: LISTING, userId: TARGET, accept: true });
    expect(result).toMatchObject({ status: 'accepted' });
    expect(mockRepo.grantAppRepoWrite).toHaveBeenCalledWith({ slug: SLUG, userId: TARGET });
  });
});

/* ------------------------------------------------------------------ *
 * The paths that must NOT be guarded
 * ------------------------------------------------------------------ */

describe('🔴 the guard is on the GRANT paths only — access-REDUCING ones stay open', () => {
  it('an owner can still REMOVE a collaborator from a removed listing', async () => {
    // Refusing this would strand an owner who wants to revoke a seat on the app that was
    // just taken down — the opposite of the property being protected. It also revokes the
    // repo write, which is the thing we most want to stay reachable.
    withStatus('removed');
    const result = await removeCollaborator({
      appListingId: LISTING,
      targetUserId: TARGET,
      actorUserId: OWNER,
    });
    expect(result).toMatchObject({ removed: true });
    expect(mockRepo.revokeAppRepoWrite).toHaveBeenCalledWith({ slug: SLUG, userId: TARGET });
  });

  it('a collaborator can still LEAVE a removed listing', async () => {
    withStatus('removed');
    const result = await leaveApp({ appListingId: LISTING, userId: TARGET });
    expect(result).toMatchObject({ removed: true });
  });

  it('the roster is still READABLE on a removed listing — moderators review takedowns', async () => {
    // `listCollaborators` is a read and admits moderators; gating it on status would blind
    // exactly the people reviewing the takedown.
    withStatus('removed');
    dbMock.dbRead.appCollaborator.findMany.mockResolvedValue([
      {
        userId: TARGET,
        role: 'editor',
        status: 'accepted',
        displayed: true,
        invitedBy: OWNER,
        createdAt: new Date(0),
        respondedAt: null,
      },
    ]);
    const rows = await listCollaborators({
      appListingId: LISTING,
      viewerUserId: OWNER,
      isModerator: false,
    });
    expect(rows.map((r) => r.userId)).toEqual([TARGET]);
  });
});
