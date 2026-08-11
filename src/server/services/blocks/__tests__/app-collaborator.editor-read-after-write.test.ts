import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE EDITOR'S FIRST MEDIA EDIT, UNDER REPLICA LAG — a SEAM test, not a unit test.
 *
 * `app-access.service.test.ts` proves `resolveListingAccess` HONOURS a pool override.
 * That is a fact about one function. This file proves the asset gates actually PASS one
 * down, which is a different claim and the one that was false: `loadOwnedListing` and
 * `resolveOwnerScreenshotTarget` both carried a `dbWrite` override, and both dropped it
 * on the floor at the collaborator branch.
 *
 * WHY THE OWNER'S SUITE COULD NEVER CATCH IT. The override exists because a shadow
 * revision is INSERTed milliseconds before the write that follows it, so a replica read
 * 404s the OWNER's first edit. An EDITOR never reaches that code path at all — a
 * shadow's `userId` is the PARENT OWNER's, so an editor always falls through the owner
 * short-circuit into the seat lookup. The seat lookup was the one read still going to
 * the replica, which converted the owner's fixed 404 into an editor's unfixed 403 on
 * exactly the same lag. Neither surface's own tests build the combined state: the owner
 * suite never has a seat, and the access suite never has a pool.
 *
 * The fixture therefore makes the replica know NOTHING — the strongest form of lag —
 * so a dropped override is observable as a DENIAL rather than as the same answer
 * arriving from a second identical fixture.
 */

const { mockRead, mockWrite } = vi.hoisted(() => {
  const make = () => ({
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      update: vi.fn(async (args: unknown) => args),
      create: vi.fn(async (args: { data: unknown }) => args.data),
    },
    appListingScreenshot: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
    appCollaborator: { findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    appBlock: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    $transaction: vi.fn(async (cb: unknown) =>
      typeof cb === 'function' ? (cb as (tx: unknown) => Promise<unknown>)(null) : cb
    ),
  });
  // 🔴 TWO OBJECTS, not one. A shared fake makes "which pool answered?" unanswerable —
  // the whole defect is a pool choice, so a fixture that cannot express the choice
  // cannot express the bug either. (Same fixture-collapse trap as the tx double in
  // `app-collaborator.service.test.ts`.)
  return { mockRead: make(), mockWrite: make() };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));

const { updateListingScreenshotCaption } = await import(
  '~/server/services/blocks/app-listing-assets.service'
);

const PARENT = 'apl_live';
const SHADOW = 'apl_shadow';
const SHOT = 'als_1';
const OWNER = 10;
const EDITOR = 20;
const STRANGER = 50;

/** The freshly-minted shadow: owned (denormalized) by the PARENT owner, not the editor. */
function shadowRow() {
  return {
    id: SHADOW,
    kind: 'onsite',
    slug: 'my-app',
    name: 'My App',
    category: null,
    contentRating: 'g',
    userId: OWNER,
    iconId: null,
    coverId: null,
    status: 'draft',
    revisionOfId: PARENT,
    appBlockId: null,
    revisionOf: { appBlockId: 'ab_app1' },
  };
}

const user = (id: number) => ({ id, isModerator: false } as never);

beforeEach(() => {
  vi.clearAllMocks();

  // THE LAGGING REPLICA: it has seen none of it — not the screenshot, not the shadow,
  // not the seat.
  mockRead.appListingScreenshot.findUnique.mockResolvedValue(null);
  mockRead.appListing.findUnique.mockResolvedValue(null);
  mockRead.appCollaborator.findFirst.mockResolvedValue(null);

  // THE PRIMARY: everything is there, committed microseconds ago.
  mockWrite.appListingScreenshot.findUnique.mockResolvedValue({
    id: SHOT,
    appListingId: SHADOW,
    appListing: { userId: OWNER },
  });
  mockWrite.appListing.findUnique.mockResolvedValue(shadowRow());
  mockWrite.appCollaborator.findFirst.mockImplementation(async (args: unknown) => {
    const w = (args as { where: { userId: number; status?: string } }).where;
    return w.userId === EDITOR && w.status === 'accepted' ? { userId: EDITOR } : null;
  });
  mockWrite.appListingScreenshot.updateMany.mockResolvedValue({ count: 1 });
});

describe('🔴 an ACCEPTED editor’s first screenshot edit does not 403 under replica lag', () => {
  it('the editor’s caption write succeeds — the seat is resolved on the pool that answered', async () => {
    await expect(
      updateListingScreenshotCaption({ screenshotId: SHOT, caption: 'hi' }, user(EDITOR))
    ).resolves.toEqual({ id: SHOT });

    // The seat lookup went to the PRIMARY…
    expect(mockWrite.appCollaborator.findFirst).toHaveBeenCalled();
    // …and never to the replica. That is the assertion the un-threaded code fails: it
    // asks the replica, gets nothing, and throws FORBIDDEN.
    expect(mockRead.appCollaborator.findFirst).not.toHaveBeenCalled();
    expect(mockWrite.appListingScreenshot.updateMany).toHaveBeenCalledOnce();
  });

  it('🔴 NEGATIVE CONTROL: the same call against a replica that CAN see everything also passes', async () => {
    // Proves the test above is measuring the POOL and not some unrelated denial: give
    // the replica the full picture and the editor gets in without the primary's seat
    // read mattering at all.
    mockRead.appListingScreenshot.findUnique.mockResolvedValue({
      id: SHOT,
      appListingId: SHADOW,
      appListing: { userId: OWNER },
    });
    mockRead.appListing.findUnique.mockResolvedValue(shadowRow());
    mockRead.appCollaborator.findFirst.mockImplementation(async (args: unknown) => {
      const w = (args as { where: { userId: number; status?: string } }).where;
      return w.userId === EDITOR && w.status === 'accepted' ? { userId: EDITOR } : null;
    });
    await expect(
      updateListingScreenshotCaption({ screenshotId: SHOT, caption: 'hi' }, user(EDITOR))
    ).resolves.toEqual({ id: SHOT });
  });

  it('🔴 the widening does NOT open the gate: a stranger is still refused ON THE PRIMARY', async () => {
    // The mutation this excludes is "thread the pool through AND stop checking the
    // seat" — which would also make the test above pass. The stranger has no seat on
    // either pool, so the only thing that can let them through is a missing check.
    await expect(
      updateListingScreenshotCaption({ screenshotId: SHOT, caption: 'hi' }, user(STRANGER))
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'You do not own this listing' });
    expect(mockWrite.appListingScreenshot.updateMany).not.toHaveBeenCalled();
  });

  it('a PENDING invitee is refused even though the primary holds their row', async () => {
    // The consent gate, re-asserted at this seam: `status: 'accepted'` is what the
    // primary is being asked, so a pending row on the primary must not resolve.
    mockWrite.appCollaborator.findFirst.mockImplementation(async (args: unknown) => {
      const w = (args as { where: { userId: number; status?: string } }).where;
      // A pending row exists, but never for `status: 'accepted'`.
      return w.userId === 30 && w.status === undefined ? { userId: 30 } : null;
    });
    await expect(
      updateListingScreenshotCaption({ screenshotId: SHOT, caption: 'hi' }, user(30))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('the OWNER still short-circuits without any seat lookup at all', async () => {
    // The pre-existing behaviour this must not regress: the common path costs no extra
    // query on either pool.
    await expect(
      updateListingScreenshotCaption({ screenshotId: SHOT, caption: 'hi' }, user(OWNER))
    ).resolves.toEqual({ id: SHOT });
    expect(mockWrite.appCollaborator.findFirst).not.toHaveBeenCalled();
    expect(mockRead.appCollaborator.findFirst).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: the two pools are distinct objects with independent spies', () => {
    expect(mockWrite).not.toBe(mockRead);
    expect(mockWrite.appCollaborator.findFirst).not.toBe(mockRead.appCollaborator.findFirst);
  });
});
