import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * 🔴 SELF-REVIEW, widened for collaborators.
 *
 * `upsertAppBlockReview`'s gate 2 used to compare the caller against the single
 * `app.userId`. With editor seats an ACCEPTED collaborator — who can edit the listing,
 * ship new versions and read the app's earnings — could 5-star the app they co-author.
 * That is the same conflict of interest the owner check exists to prevent.
 *
 * The asymmetries this suite pins, each of which is a decision that could plausibly
 * have gone the other way:
 *   - an accepted collaborator IS an insider (blocked);
 *   - an UNDISPLAYED accepted collaborator is STILL an insider — hiding your byline
 *     must not be a self-review bypass;
 *   - a PENDING or REJECTED invitee is NOT an insider — otherwise an owner could
 *     silence a critic by inviting them.
 */

// One local served both clients. `upsertAppBlockReview` writes on dbWrite
// (appBlockReview.service:157, :179, :186, :197) and reads everything else on dbRead:
// `appBlock.findUnique` at :49, `blockUserSubscription.findFirst` at :81.
//
// 🔴 `appCollaborator.findMany` is dbRead too, and it is NOT spelled anywhere in
// appBlockReview.service — `getAppInsiderUserIds` (:74-77) reaches it through a deferred
// `await import('~/server/services/blocks/app-access.service')`, and the call is
// `dbRead.appCollaborator.findMany` at app-access.service:1111. A per-module scan reports it on
// neither client, which reads as "this call exists nowhere" rather than as "look one hop further".
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

mockDbWrite.appBlockReview.create.mockResolvedValue({});
mockDbWrite.appBlockReview.update.mockResolvedValue({});
vi.mock('~/server/utils/cache-helpers', () => ({ bustCacheTag: vi.fn(async () => undefined) }));

const { upsertAppBlockReview } = await import('~/server/services/appBlockReview.service');

const APP = 'ab_app1';
/**
 * 🔴 The block's STORE LISTING. Seats are keyed here since the block→listing re-key, so
 * the insider read hops `AppBlock → AppListing → app_collaborators`.
 */
const LISTING = 'apl_live';
const OWNER = 10;
const ACCEPTED_EDITOR = 20;
const HIDDEN_EDITOR = 21; // accepted, displayed:false
const PENDING_INVITEE = 30;
const REJECTED_INVITEE = 40;
const OUTSIDER = 50;

const SEATS = [
  { appListingId: LISTING, userId: ACCEPTED_EDITOR, status: 'accepted', displayed: true },
  { appListingId: LISTING, userId: HIDDEN_EDITOR, status: 'accepted', displayed: false },
  { appListingId: LISTING, userId: PENDING_INVITEE, status: 'pending', displayed: true },
  { appListingId: LISTING, userId: REJECTED_INVITEE, status: 'rejected', displayed: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockDbRead.appBlock.findUnique.mockResolvedValue({
    app: { userId: OWNER },
    appListing: { id: LISTING },
  });
  mockDbRead.appCollaborator.findMany.mockImplementation(async (args: unknown) => {
    const w = (args as { where: { appListingId?: string; status?: string; displayed?: boolean } })
      .where;
    return SEATS.filter(
      (r) =>
        // 🔴 Honouring `appListingId` is load-bearing: without it the insider set would
        // be satisfied by seats on ANY listing and the hop would be untested.
        (w.appListingId === undefined || r.appListingId === w.appListingId) &&
        (w.status === undefined || r.status === w.status) &&
        (w.displayed === undefined || r.displayed === w.displayed)
    ).map((r) => ({ userId: r.userId }));
  });
  // Every caller below has an enabled install, so gate 3 never masks gate 2.
  mockDbRead.blockUserSubscription.findFirst.mockResolvedValue({ id: 'bus_1' });
});

const review = (userId: number) => upsertAppBlockReview({ userId, appBlockId: APP, rating: 5 });

describe('upsertAppBlockReview — the insider set', () => {
  it('the OWNER cannot review (unchanged)', async () => {
    await expect(review(OWNER)).rejects.toThrow('You cannot review your own app');
  });

  it('🔴 an ACCEPTED COLLABORATOR cannot review', async () => {
    await expect(review(ACCEPTED_EDITOR)).rejects.toThrow('You cannot review your own app');
    expect(mockDbWrite.appBlockReview.create).not.toHaveBeenCalled();
  });

  it('🔴 an accepted collaborator with `displayed: false` STILL cannot review', async () => {
    // Hiding your byline is a public-credit preference, not a capability change.
    // Filtering the insider set on `displayed` would turn it into a bypass.
    await expect(review(HIDDEN_EDITOR)).rejects.toThrow('You cannot review your own app');
  });

  it('a PENDING invitee CAN review — an invite must not silence a critic', async () => {
    await expect(review(PENDING_INVITEE)).resolves.toBeTruthy();
  });

  it('a REJECTED invitee CAN review', async () => {
    await expect(review(REJECTED_INVITEE)).resolves.toBeTruthy();
  });

  it('an ordinary user CAN review', async () => {
    await expect(review(OUTSIDER)).resolves.toBeTruthy();
  });

  it('POSITIVE CONTROL: the happy path really does write a review', async () => {
    // Otherwise the four "resolves" above could be passing for the wrong reason.
    await review(OUTSIDER);
    expect(mockDbWrite.appBlockReview.create).toHaveBeenCalledOnce();
  });

  it('a missing app is a BAD_REQUEST, not a silent allow', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    await expect(review(OUTSIDER)).rejects.toThrow('App block not found');
  });

  it('the insider set degrades to OWNER-ONLY when the seat table is absent', async () => {
    // Pre-migration: the review gate must keep working exactly as it did before.
    mockDbRead.appCollaborator.findMany.mockRejectedValue(
      Object.assign(new Error('does not exist'), { code: 'P2021' })
    );
    await expect(review(OWNER)).rejects.toThrow('You cannot review your own app');
    await expect(review(ACCEPTED_EDITOR)).resolves.toBeTruthy();
  });

  it('🔴 a block with NO store listing has an OWNER-ONLY insider set (nothing to seat on)', async () => {
    // A first-version app pending approval has no `AppListing` row yet, so there is no
    // id under which a seat could exist. The gate must still refuse the owner, and must
    // not throw trying to key a query on `undefined`.
    mockDbRead.appBlock.findUnique.mockResolvedValue({ app: { userId: OWNER }, appListing: null });
    await expect(review(OWNER)).rejects.toThrow('You cannot review your own app');
    await expect(review(ACCEPTED_EDITOR)).resolves.toBeTruthy();
    expect(mockDbRead.appCollaborator.findMany).not.toHaveBeenCalled();
  });

  it('🔴 the seat query is keyed on the block’s LISTING, not on the block', async () => {
    // The hop, asserted directly. A query still keyed on `appBlockId` would match no
    // fixture row and every insider would silently become a permitted reviewer.
    await review(OUTSIDER);
    expect(mockDbRead.appCollaborator.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { appListingId: LISTING, status: 'accepted' } })
    );
  });
});
