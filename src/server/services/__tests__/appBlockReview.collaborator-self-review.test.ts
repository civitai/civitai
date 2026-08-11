import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    appBlock: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    appCollaborator: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    blockUserSubscription: { findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    appBlockReview: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/utils/cache-helpers', () => ({ bustCacheTag: vi.fn(async () => undefined) }));

const { upsertAppBlockReview } = await import('~/server/services/appBlockReview.service');

const APP = 'ab_app1';
const OWNER = 10;
const ACCEPTED_EDITOR = 20;
const HIDDEN_EDITOR = 21; // accepted, displayed:false
const PENDING_INVITEE = 30;
const REJECTED_INVITEE = 40;
const OUTSIDER = 50;

const SEATS = [
  { userId: ACCEPTED_EDITOR, status: 'accepted', displayed: true },
  { userId: HIDDEN_EDITOR, status: 'accepted', displayed: false },
  { userId: PENDING_INVITEE, status: 'pending', displayed: true },
  { userId: REJECTED_INVITEE, status: 'rejected', displayed: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.appBlock.findUnique.mockResolvedValue({ app: { userId: OWNER } });
  mockDb.appCollaborator.findMany.mockImplementation(async (args: unknown) => {
    const w = (args as { where: { status?: string; displayed?: boolean } }).where;
    return SEATS.filter(
      (r) =>
        (w.status === undefined || r.status === w.status) &&
        (w.displayed === undefined || r.displayed === w.displayed)
    ).map((r) => ({ userId: r.userId }));
  });
  // Every caller below has an enabled install, so gate 3 never masks gate 2.
  mockDb.blockUserSubscription.findFirst.mockResolvedValue({ id: 'bus_1' });
});

const review = (userId: number) => upsertAppBlockReview({ userId, appBlockId: APP, rating: 5 });

describe('upsertAppBlockReview — the insider set', () => {
  it('the OWNER cannot review (unchanged)', async () => {
    await expect(review(OWNER)).rejects.toThrow('You cannot review your own app');
  });

  it('🔴 an ACCEPTED COLLABORATOR cannot review', async () => {
    await expect(review(ACCEPTED_EDITOR)).rejects.toThrow('You cannot review your own app');
    expect(mockDb.appBlockReview.create).not.toHaveBeenCalled();
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
    expect(mockDb.appBlockReview.create).toHaveBeenCalledOnce();
  });

  it('a missing app is a BAD_REQUEST, not a silent allow', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue(null);
    await expect(review(OUTSIDER)).rejects.toThrow('App block not found');
  });

  it('the insider set degrades to OWNER-ONLY when the seat table is absent', async () => {
    // Pre-migration: the review gate must keep working exactly as it did before.
    mockDb.appCollaborator.findMany.mockRejectedValue(
      Object.assign(new Error('does not exist'), { code: 'P2021' })
    );
    await expect(review(OWNER)).rejects.toThrow('You cannot review your own app');
    await expect(review(ACCEPTED_EDITOR)).resolves.toBeTruthy();
  });
});
