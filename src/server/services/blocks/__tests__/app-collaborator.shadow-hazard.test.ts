import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as AppBlockIds from '~/server/utils/app-block-ids';

/**
 * 🔴 THE SHADOW HAZARD — a collaborator seat may live ONLY on a PARENT listing.
 *
 * ## The defect this file exists to keep out
 *
 * Seats are keyed to `AppListing` (the block→listing re-key), and a listing can be
 * CLONED into a hidden shadow revision (`revisionOfId != null`) while its owner edits.
 * `applyApprovedRevision` DELETES that shadow when a moderator approves the revision,
 * and `app_collaborators.app_listing_id` is `ON DELETE CASCADE`. So a seat that landed
 * on a shadow would be destroyed by an ordinary approve — silently, with no error, and
 * with the invite's audit event still on record claiming the person was seated.
 *
 * A SQL CHECK cannot express "parent only": a row-level CHECK cannot see another row's
 * `revision_of_id`. So the invariant is held in code, from both ends, and this file
 * pins BOTH — against ONE shared fake seat table, so the two halves cannot be true of
 * different worlds:
 *
 *   A. a seat on the PARENT SURVIVES an approve (the cascade never reaches it); and
 *   B. a seat CANNOT BE CREATED on a shadow in the first place.
 *
 * 🔴 THE CASCADE IS MODELLED, NOT ASSUMED. The fake `appListing.deleteMany` deletes the
 * seats of the listing it removes, exactly as the FK would. Without that, (A) would be a
 * fact about a mock that never deletes anything — a reassuring zero. The negative
 * control below hand-plants a seat ON the shadow and watches the same approve destroy
 * it, which is what proves the cascade fake bites AND demonstrates the precise hazard
 * that (B) prevents.
 */

const PARENT = 'apl_parent';
const SHADOW = 'apl_shadow';
const SLUG = 'my-app';
const APP = 'ab_app1';
const OWNER = 10;
const EDITOR = 20;
const MOD = 7;

type Seat = { appListingId: string; userId: number; status: string; displayed: boolean };

const { store, mockRead, mockWrite, mockNotifyListing, mockRepo, mockNotifyCollab, seq } =
  vi.hoisted(() => {
    const store: { seats: Seat[] } = { seats: [] };

    /**
     * The seat-table delegate. SHARED by the read and write clients, so an invite issued
     * through `dbWrite` is visible to a later read through `dbRead` — the two halves of
     * this file must operate on ONE table or the seam is untested.
     */
    const appCollaborator = {
      findUnique: vi.fn(async (args: unknown) => {
        const k = (
          args as { where: { appListingId_userId: { appListingId: string; userId: number } } }
        ).where.appListingId_userId;
        return (
          store.seats.find((s) => s.appListingId === k.appListingId && s.userId === k.userId) ??
          null
        );
      }),
      findFirst: vi.fn(async (args: unknown) => {
        const w = (args as { where: { appListingId?: string; userId?: number; status?: string } })
          .where;
        return (
          store.seats.find(
            (s) =>
              (w.appListingId === undefined || s.appListingId === w.appListingId) &&
              (w.userId === undefined || s.userId === w.userId) &&
              (w.status === undefined || s.status === w.status)
          ) ?? null
        );
      }),
      findMany: vi.fn(async (args: unknown) => {
        const w = (args as { where: { appListingId?: string; userId?: number; status?: unknown } })
          .where;
        return store.seats.filter(
          (s) =>
            (w.appListingId === undefined || s.appListingId === w.appListingId) &&
            (w.userId === undefined || s.userId === w.userId) &&
            (w.status === undefined ||
              (typeof w.status === 'string'
                ? s.status === w.status
                : (w.status as { in: string[] }).in.includes(s.status)))
        );
      }),
      count: vi.fn(async (args: unknown) => {
        const w = (args as { where: { appListingId?: string; status?: { in: string[] } } }).where;
        return store.seats.filter(
          (s) =>
            (w.appListingId === undefined || s.appListingId === w.appListingId) &&
            (w.status === undefined || w.status.in.includes(s.status))
        ).length;
      }),
      upsert: vi.fn(async (args: unknown) => {
        const a = args as {
          where: { appListingId_userId: { appListingId: string; userId: number } };
          create: Seat;
        };
        const k = a.where.appListingId_userId;
        const existing = store.seats.find(
          (s) => s.appListingId === k.appListingId && s.userId === k.userId
        );
        if (existing) return existing;
        const row: Seat = {
          appListingId: a.create.appListingId,
          userId: a.create.userId,
          status: a.create.status,
          displayed: true,
        };
        store.seats.push(row);
        return row;
      }),
      updateMany: vi.fn(async (args: unknown) => {
        const a = args as {
          where: { appListingId?: string; userId?: number; status?: string };
          data: Partial<Seat>;
        };
        let n = 0;
        for (const s of store.seats) {
          if (a.where.appListingId !== undefined && s.appListingId !== a.where.appListingId)
            continue;
          if (a.where.userId !== undefined && s.userId !== a.where.userId) continue;
          if (a.where.status !== undefined && s.status !== a.where.status) continue;
          Object.assign(s, a.data);
          n += 1;
        }
        return { count: n };
      }),
      deleteMany: vi.fn(async (args: unknown) => {
        const w = (args as { where: { appListingId?: string; userId?: number } }).where;
        const before = store.seats.length;
        store.seats = store.seats.filter(
          (s) =>
            !(
              (w.appListingId === undefined || s.appListingId === w.appListingId) &&
              (w.userId === undefined || s.userId === w.userId)
            )
        );
        return { count: before - store.seats.length };
      }),
    };

    const makeClient = () => ({
      appCollaborator,
      appOwnershipEvent: { create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})) },
      user: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
      appBlock: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
      appListing: {
        findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
        findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
        create: vi.fn(async (args: { data: unknown }) => args.data),
        update: vi.fn(async (args: { data: unknown }) => args.data),
        updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
        /**
         * 🔴 THE FK CASCADE, modelled. Deleting a listing deletes its seats, exactly as
         * `ON DELETE CASCADE` would. This is the whole instrument.
         */
        deleteMany: vi.fn(async (args: unknown) => {
          const id = (args as { where: { id?: string } }).where.id;
          if (id) store.seats = store.seats.filter((s) => s.appListingId !== id);
          return { count: 1 };
        }),
      },
      appListingScreenshot: {
        count: vi.fn(async (..._a: unknown[]) => 1),
        findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
        createMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
        deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
        updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
      },
      appListingModerationEvent: { create: vi.fn(async (args: { data: unknown }) => args.data) },
      image: { findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) },
      appListingPublishRequest: {
        findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
        findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
        findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
        create: vi.fn(async (args: { data: unknown }) => args.data),
        updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
      },
    });

    const mockRead = makeClient();
    const mockWrite = makeClient() as ReturnType<typeof makeClient> & {
      $transaction: ReturnType<typeof vi.fn>;
    };
    mockWrite.$transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));

    return {
      store,
      mockRead,
      mockWrite,
      mockNotifyListing: vi.fn(async () => undefined),
      mockRepo: {
        grantAppRepoWrite: vi.fn(async () => undefined),
        revokeAppRepoWrite: vi.fn(async () => undefined),
      },
      mockNotifyCollab: { notifyAppCollaborator: vi.fn(async () => undefined) },
      seq: { n: 0 },
    };
  });

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/server/services/blocks/app-listing-notify', () => ({
  notifyAppListingOwner: mockNotifyListing,
}));
vi.mock('~/server/services/blocks/app-repo-access', () => mockRepo);
vi.mock('~/server/services/blocks/app-collaborator-notify', () => mockNotifyCollab);
vi.mock('~/server/utils/app-block-ids', async (importOriginal) => {
  const actual = await importOriginal<typeof AppBlockIds>();
  return { ...actual, newAppListingModerationEventId: () => `alme_${++seq.n}` };
});

const { approveExternalRequest } = await import('~/server/services/blocks/offsite-listing.service');
const { inviteCollaborator } = await import('~/server/services/blocks/app-collaborator.service');

/** The listing rows both the read and the write client serve. */
function listingRow(id: string) {
  if (id === SHADOW) {
    return {
      id: SHADOW,
      slug: SLUG,
      kind: 'offsite',
      status: 'draft',
      userId: OWNER,
      appBlockId: null,
      revisionOfId: PARENT,
      revisionOf: { id: PARENT, kind: 'offsite', appBlockId: null },
      appBlock: null,
      externalUrl: 'https://example.com/',
      connectClientId: null,
      connectRequestedScopes: null,
      connectScopeJustifications: null,
      connectClient: null,
      name: 'Edited Name',
      tagline: 'Edited tagline',
      description: 'Edited description',
      category: 'games',
      contentRating: 'pg',
      iconId: 99,
      coverId: 88,
    };
  }
  if (id === PARENT) {
    return {
      id: PARENT,
      slug: SLUG,
      kind: 'offsite',
      status: 'approved',
      userId: OWNER,
      appBlockId: null,
      revisionOfId: null,
      revisionOf: null,
      appBlock: null,
      externalUrl: 'https://example.com/',
      connectClientId: null,
      connectRequestedScopes: null,
      connectScopeJustifications: null,
      connectClient: null,
      iconId: 1,
      coverId: 2,
    };
  }
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  seq.n = 0;
  store.seats = [];
  mockWrite.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb(mockWrite)
  );
  for (const c of [mockRead, mockWrite]) {
    c.appListing.findUnique.mockImplementation(async (args: unknown) =>
      listingRow((args as { where: { id: string } }).where.id)
    );
    c.appListing.deleteMany.mockImplementation(async (args: unknown) => {
      const id = (args as { where: { id?: string } }).where.id;
      if (id) store.seats = store.seats.filter((s) => s.appListingId !== id);
      return { count: 1 };
    });
    c.appListingScreenshot.findMany.mockResolvedValue([]);
    c.appListingPublishRequest.updateMany.mockResolvedValue({ count: 1 });
    c.image.findMany.mockImplementation(async (...a: unknown[]) => {
      const ids = (a[0] as { where?: { id?: { in?: number[] } } })?.where?.id?.in ?? [];
      return ids.map((id) => ({ id, ingestion: 'Scanned' }));
    });
    c.user.findUnique.mockResolvedValue({ id: EDITOR, bannedAt: null });
    c.appBlock.findUnique.mockResolvedValue({
      id: APP,
      blockId: SLUG,
      app: { userId: OWNER },
      appListing: { id: PARENT },
    });
  }
  // The pending revision request the moderator is approving.
  mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
    id: 'alpr_rev',
    status: 'pending',
    kind: 'offsite',
    slug: SLUG,
    appListingId: SHADOW,
  });
});

/** Seat `userId` on `listingId` directly, bypassing the invite guard. */
function plantSeat(listingId: string, userId: number, status = 'accepted') {
  store.seats.push({ appListingId: listingId, userId, status, displayed: true });
}

const approve = () => approveExternalRequest({ publishRequestId: 'alpr_rev', reviewerUserId: MOD });

describe('🔴 INSTRUMENT CONTROLS — the cascade fake must actually bite', () => {
  it('the approve really does delete the shadow', async () => {
    await approve();
    expect(mockWrite.appListing.deleteMany).toHaveBeenCalledWith({
      where: { id: SHADOW, revisionOfId: { not: null } },
    });
  });

  it('🔴 NEGATIVE CONTROL: a seat planted ON THE SHADOW is DESTROYED by that same approve', async () => {
    // This is the hazard, demonstrated. It is also the proof that the "survives"
    // assertion below is not a fact about a mock that never deletes anything: the exact
    // same approve, on the exact same fake, annihilates a shadow-keyed seat.
    plantSeat(SHADOW, EDITOR);
    expect(store.seats).toHaveLength(1);
    await approve();
    expect(store.seats).toEqual([]);
  });
});

describe('🔴 DIRECTION A — a seat on the PARENT survives a revision approve', () => {
  it('the parent’s accepted seat is still there afterwards', async () => {
    plantSeat(PARENT, EDITOR);
    await approve();
    expect(store.seats).toEqual([
      { appListingId: PARENT, userId: EDITOR, status: 'accepted', displayed: true },
    ]);
  });

  it('…and the approve never issues a seat delete of its own', async () => {
    // Belt and braces: the cascade is one way to lose the seat; an explicit cleanup
    // added to `applyApprovedRevision` would be another, and it would not show up as a
    // cascade at all.
    plantSeat(PARENT, EDITOR);
    await approve();
    expect(mockWrite.appCollaborator.deleteMany).not.toHaveBeenCalled();
    expect(mockWrite.appCollaborator.updateMany).not.toHaveBeenCalled();
  });

  it('🔴 MIXED: a parent seat survives while a (hand-planted) shadow seat does not', async () => {
    // Both rows go through the SAME cascade in the SAME call, so the survivor set is
    // decided by the KEY and nothing else — which is exactly the claim.
    plantSeat(PARENT, EDITOR);
    plantSeat(SHADOW, 999);
    await approve();
    expect(store.seats.map((s) => s.appListingId)).toEqual([PARENT]);
  });
});

describe('🔴 DIRECTION B — a seat cannot be created on a shadow', () => {
  it('inviting on the shadow is refused and the seat table stays empty', async () => {
    await expect(
      inviteCollaborator({ appListingId: SHADOW, targetUserId: EDITOR, actorUserId: OWNER })
    ).rejects.toMatchObject({
      code: 'INVALID_TARGET',
      message: 'Collaborators are managed on the live listing, not on a revision draft',
    });
    expect(store.seats).toEqual([]);
  });

  it('POSITIVE CONTROL: the same invite on the PARENT does seat them', async () => {
    // Without this, "the table stayed empty" is indistinguishable from an invite path
    // that never writes at all.
    await inviteCollaborator({ appListingId: PARENT, targetUserId: EDITOR, actorUserId: OWNER });
    expect(store.seats).toEqual([
      { appListingId: PARENT, userId: EDITOR, status: 'pending', displayed: true },
    ]);
  });

  it('🔴 THE SEAM, end to end: invite on the parent → approve the shadow → the seat is still there', async () => {
    // The two halves joined. This is the property the feature actually promises: an
    // editor invited while a revision is in flight does not lose their seat when a
    // moderator approves that revision.
    await inviteCollaborator({ appListingId: PARENT, targetUserId: EDITOR, actorUserId: OWNER });
    expect(store.seats).toHaveLength(1);
    await approve();
    expect(store.seats).toEqual([
      { appListingId: PARENT, userId: EDITOR, status: 'pending', displayed: true },
    ]);
  });
});
