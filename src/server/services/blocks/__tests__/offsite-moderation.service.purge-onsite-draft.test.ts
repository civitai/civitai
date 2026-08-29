import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `purgeListing` — the ON-SITE ORPHAN PRE-APPROVAL DRAFT arm (clawgate #302 / ClickUp
 * 868kuam02).
 *
 * 🔴 WHY THIS ARM EXISTS, because it reads like new destructive power and is the opposite.
 * `rejectRequest` used to run `deleteOnsiteDraftListingForSlug` on EVERY reject, so
 * rejecting a first-time developer over a fixable problem hard-deleted the store listing
 * they had built and released their slug — invisibly, with no reason recorded and no way
 * for the reviewer to decline it. That call is gone. The same delete now happens only when
 * a mod ASKS for it, here, with a required reason and an `action:'purge'` audit event.
 *
 * Removing this arm without replacing it would strand every rejected first submission:
 * `delistListing` is status-guarded to `{approved, removed}` and cannot touch a `draft`,
 * so an orphan draft would hold its slug with NO recourse.
 *
 * 🔴 THE PREDICATE IS NARROW ON PURPOSE, and the term that carries the most weight is
 * `revisionOfId: null`. A SHADOW media revision (`beginListingRevision`) is created with
 * the PARENT's `kind`, `status:'draft'` and `appBlockId: null` — it matches every OTHER
 * term of the on-site arm. `deleteOnsiteDraftListingForSlug` gets away without that term
 * only because it resolves BY SLUG and a shadow's slug is a synthetic `rev-<ulid>`; a
 * purge resolves BY ID. Without `revisionOfId: null` a mod could hard-delete an in-flight
 * media revision of a LIVE, approved on-site app — which is why the refusal cases below
 * are the point of this file, not the happy path.
 *
 * DB fully mocked. `$transaction` runs its callback against the same write mock, so a
 * test can assert that a guarded refusal throws BEFORE any audit event is written.
 */

const { mockRead, mockWrite, ids } = vi.hoisted(() => {
  const ids = { n: 0 };
  const mockWrite = {
    $transaction: vi.fn(),
    appListing: {
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
    },
    appListingModerationEvent: { create: vi.fn() },
    appListingReport: { updateMany: vi.fn() },
  };
  const mockRead = { appListing: { findUnique: vi.fn() } };
  return { mockRead, mockWrite, ids };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingReportId: () => `alrp_test_${++ids.n}`,
  newAppListingModerationEventId: () => `alme_test_${++ids.n}`,
  newAppListingPublishRequestId: () => `alpr_test_${++ids.n}`,
  newAppOwnershipEventId: () => `aoe_test_${++ids.n}`,
}));
vi.mock('~/server/services/blocks/app-listing-notify', () => ({
  notifyAppListingOwner: vi.fn(async () => undefined),
}));

const { purgeListing } = await import('~/server/services/blocks/offsite-moderation.service');

const REVIEWER = 1001;
const APP_ID = 'apl_target';
const SLUG = 'cool-app';
const REASON = 'confirmed spam submission, expunging';

/** The purgeable on-site shape: never approved, not a shadow. */
function orphanDraft(over: Record<string, unknown> = {}) {
  return {
    id: APP_ID,
    kind: 'onsite',
    status: 'draft',
    slug: SLUG,
    appBlockId: null,
    revisionOfId: null,
    userId: 77,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ids.n = 0;
  mockWrite.$transaction.mockImplementation(async (fn: unknown) =>
    typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(mockWrite) : undefined
  );
  mockWrite.appListing.deleteMany.mockResolvedValue({ count: 1 });
  mockWrite.appListingModerationEvent.create.mockResolvedValue({});
});

describe('purgeListing — on-site orphan pre-approval draft (the purgeable shape)', () => {
  it('purges it, writing the audit event BEFORE the delete', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(orphanDraft());
    mockWrite.appListing.findUnique.mockResolvedValueOnce(orphanDraft());

    const res = await purgeListing({
      input: { appListingId: APP_ID, reason: REASON },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: APP_ID, purged: true });

    const createOrder = mockWrite.appListingModerationEvent.create.mock.invocationCallOrder[0];
    const deleteOrder = mockWrite.appListing.deleteMany.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(deleteOrder);

    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data).toMatchObject({
      action: 'purge',
      slug: SLUG,
      actorUserId: REVIEWER,
      reason: REASON,
      before: { status: 'draft' },
    });
  });

  it('guards the delete with the full purgeable predicate, not just the id', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(orphanDraft());
    mockWrite.appListing.findUnique.mockResolvedValueOnce(orphanDraft());
    await purgeListing({
      input: { appListingId: APP_ID, reason: REASON },
      reviewerUserId: REVIEWER,
    });

    // Literal, not the service's own constant — an expectation built from the
    // implementation cannot notice the implementation changing.
    expect(mockWrite.appListing.deleteMany).toHaveBeenCalledWith({
      where: {
        id: APP_ID,
        OR: [
          { kind: 'offsite' },
          { kind: 'onsite', status: 'draft', appBlockId: null, revisionOfId: null },
        ],
      },
    });
  });
});

/**
 * 🔴 THE REFUSALS ARE THE POINT. Each row below differs from the purgeable shape in
 * exactly ONE term, so a mutant that drops that term is caught by exactly one case and the
 * others stay green — the failure names the missing term instead of "purge is broken".
 */
describe('purgeListing — refuses every on-site shape that is NOT an orphan draft', () => {
  const cases: Array<{ what: string; row: Record<string, unknown>; why: string }> = [
    {
      what: 'a SHADOW media revision of a live app',
      row: orphanDraft({ revisionOfId: 'apl_parent_live' }),
      why: 'same kind + draft + null appBlockId as an orphan; only revisionOfId separates them',
    },
    {
      what: 'a draft that already has a backing AppBlock',
      row: orphanDraft({ appBlockId: 'ablk_live' }),
      why: 'it reached approve — deleting it would orphan a hosted app',
    },
    {
      what: 'an APPROVED on-site listing',
      row: orphanDraft({ status: 'approved' }),
      why: 'delistListing is the correct action; purge must not hide a card while the block serves',
    },
    {
      what: 'a REMOVED on-site listing',
      row: orphanDraft({ status: 'removed' }),
      why: 'already delisted; still not purgeable through the on-site arm',
    },
  ];

  for (const { what, row, why } of cases) {
    it(`refuses ${what} at the replica classify, with no tx opened — ${why}`, async () => {
      mockRead.appListing.findUnique.mockResolvedValueOnce(row);
      await expect(
        purgeListing({ input: { appListingId: APP_ID, reason: REASON }, reviewerUserId: REVIEWER })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(mockWrite.$transaction).not.toHaveBeenCalled();
      expect(mockWrite.appListing.deleteMany).not.toHaveBeenCalled();
    });
  }

  it('gives a MISSING row and a non-purgeable row the SAME message (no kind/status probing)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(null);
    const missing = await purgeListing({
      input: { appListingId: APP_ID, reason: REASON },
      reviewerUserId: REVIEWER,
    }).catch((e: Error) => e.message);

    mockRead.appListing.findUnique.mockResolvedValueOnce(orphanDraft({ status: 'approved' }));
    const refused = await purgeListing({
      input: { appListingId: APP_ID, reason: REASON },
      reviewerUserId: REVIEWER,
    }).catch((e: Error) => e.message);

    expect(missing).toBe(refused);
  });
});

/**
 * 🔴 THE RACE THAT MATTERS FOR THIS ARM. `approveRequest` turns exactly this row from an
 * orphan draft into an APPROVED listing with a backing AppBlock. A purge that classified
 * against a lagging REPLICA and then deleted would take out a live app's store card, so
 * the predicate is re-evaluated on the PRIMARY inside the tx — and again in the delete.
 */
describe('purgeListing — the classify→delete race on the on-site arm', () => {
  it('replica says orphan draft, primary says approved → NOT_FOUND with ZERO events', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(orphanDraft());
    mockWrite.appListing.findUnique.mockResolvedValueOnce(
      orphanDraft({ status: 'approved', appBlockId: 'ablk_live' })
    );

    await expect(
      purgeListing({ input: { appListingId: APP_ID, reason: REASON }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
    expect(mockWrite.appListing.deleteMany).not.toHaveBeenCalled();
  });

  it('a raced 0-count delete → NOT_FOUND (the tx, event included, rolls back)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(orphanDraft());
    mockWrite.appListing.findUnique.mockResolvedValueOnce(orphanDraft());
    mockWrite.appListing.deleteMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      purgeListing({ input: { appListingId: APP_ID, reason: REASON }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('still requires a mod reason (the floor is not bypassed by the new arm)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(orphanDraft());
    await expect(
      purgeListing({ input: { appListingId: APP_ID, reason: '  ' }, reviewerUserId: REVIEWER })
    ).rejects.toThrow();
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });
});
