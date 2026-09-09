import { beforeEach, describe, expect, it, vi } from 'vitest';

import { purgeListing } from '~/server/services/blocks/offsite-moderation.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

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
 * DB deps come from the canonical `dbMock` — no real Prisma, and no per-file mock of the db
 * client, which `no-direct-shared-module-mock` forbids: under `isolate: false` a per-file db
 * mock freezes its own shape into every later file in the same worker. `$transaction`'s
 * canonical default runs its callback against `dbWrite`, which is exactly the tx client these
 * assertions read — so a test can assert that a guarded refusal throws BEFORE any audit event
 * is written.
 *
 * 🔴 Do not name that specifier inside a `vi.mock(...)` call shape ANYWHERE in this file,
 * prose included. The guard is a regex over the file's source text, so a mention in a comment
 * is indistinguishable from a real registration and fails the build. (It did.)
 */

const { ids, mockNotify } = vi.hoisted(() => ({
  ids: { n: 0 },
  mockNotify: vi.fn(async () => undefined),
}));

vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingReportId: () => `alrp_test_${++ids.n}`,
  newAppListingModerationEventId: () => `alme_test_${++ids.n}`,
  newAppListingPublishRequestId: () => `alpr_test_${++ids.n}`,
  newAppOwnershipEventId: () => `aoe_test_${++ids.n}`,
}));
vi.mock('~/server/services/blocks/app-listing-notify', () => ({
  notifyAppListingOwner: mockNotify,
}));

const mockRead = dbMock.dbRead;
const mockWrite = dbMock.dbWrite;

const REVIEWER = 1001;
const APP_ID = 'apl_target';
const SLUG = 'cool-app';
const REASON = 'confirmed spam submission, expunging';

const OWNER = 77;
const APP_NAME = 'Cool App';

/**
 * The purgeable on-site shape: never approved, not a shadow. "Not under review" is NOT a field
 * on this row — it is a separate slug-keyed lookup, staged by {@link stageLiveSubmission}.
 */
function orphanDraft(over: Record<string, unknown> = {}) {
  return {
    id: APP_ID,
    kind: 'onsite',
    status: 'draft',
    slug: SLUG,
    name: APP_NAME,
    appBlockId: null,
    revisionOfId: null,
    userId: OWNER,
    ...over,
  };
}

/**
 * 🔴 STAGE THE "UNDER REVIEW" SIGNAL ON THE RIGHT TABLE.
 *
 * The live submission behind an on-site pre-approval draft is an `AppBlockPublishRequest`
 * joined to the listing by the shared `@unique` SLUG — there is NO foreign key.
 * `AppListing.publishRequests` is the `AppListingPublishRequest` relation, whose `appListingId`
 * the schema documents as "On-site: NULL until approve", so for this shape it is provably
 * always empty.
 *
 * An earlier revision of this file staged `publishRequests: [{ id: 'pubreq_live' }]` on the
 * listing fixture and asserted the purge was refused. That state cannot exist in the database,
 * so the test certified a guard that was a tautology — it passed, and a mutation of the guard
 * "died" against it, while the production path deleted listings under active review. Fixtures
 * that can only produce the shape the guard already assumes prove nothing.
 */
function stageLiveSubmission(present: boolean) {
  mockRead.appBlockPublishRequest.findFirst.mockResolvedValue(
    present ? { id: 'pubreq_live' } : null
  );
  mockWrite.appBlockPublishRequest.findFirst.mockResolvedValue(
    present ? { id: 'pubreq_live' } : null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  ids.n = 0;
  // 🔴 `mockReset()`, not just `clearAllMocks()`. `clearAllMocks` clears CALLS but leaves a
  // queued `mockResolvedValueOnce` in place, and the refusal tests below deliberately throw
  // BEFORE reaching the in-tx read — so an unconsumed `Once` value would survive into the
  // next test and decide it. Reset then re-apply, so every default is set explicitly here.
  mockRead.appListing.findUnique.mockReset();
  mockWrite.appListing.findUnique.mockReset();
  mockWrite.appListing.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  mockWrite.appListingModerationEvent.create.mockReset().mockResolvedValue({});
  mockNotify.mockReset().mockResolvedValue(undefined);
  mockRead.appBlockPublishRequest.findFirst.mockReset().mockResolvedValue(null);
  mockWrite.appBlockPublishRequest.findFirst.mockReset().mockResolvedValue(null);
  // `$transaction` is deliberately NOT reset — that would discard the canonical default
  // (run the callback against `dbWrite`), which is the behaviour these tests rely on.
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

  /**
   * 🔴 The developer's listing, its media and their slug are being hard-deleted. Unlike the
   * off-site arm — only reachable on an already-`removed` listing, i.e. after a `delistListing`
   * that notified — this arm fires straight off a `draft`, so without this it is a silent
   * deletion of a user's content.
   */
  it('notifies the OWNER, post-commit, carrying the mod reason', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(orphanDraft());
    mockWrite.appListing.findUnique.mockResolvedValueOnce(orphanDraft());
    await purgeListing({
      input: { appListingId: APP_ID, reason: REASON },
      reviewerUserId: REVIEWER,
    });

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0]).toMatchObject({
      type: 'app-listing-purged',
      userId: OWNER,
      // Keyed by LISTING id, never slug: this delete RELEASES the slug, so a slug key could
      // dedup a later, different developer's notification away.
      key: `app-listing-purged:${APP_ID}`,
      details: { slug: SLUG, name: APP_NAME, reason: REASON },
    });
  });

  it('the purge STANDS if the notification throws (post-commit, best-effort)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(orphanDraft());
    mockWrite.appListing.findUnique.mockResolvedValueOnce(orphanDraft());
    mockNotify.mockRejectedValueOnce(new Error('notification backend down'));
    await expect(
      purgeListing({ input: { appListingId: APP_ID, reason: REASON }, reviewerUserId: REVIEWER })
    ).resolves.toEqual({ appListingId: APP_ID, purged: true });
    expect(mockWrite.appListing.deleteMany).toHaveBeenCalled();
  });

  it('an OFF-SITE purge still notifies NOBODY — that arm follows a delist that already did', async () => {
    const offsiteRow = orphanDraft({ kind: 'offsite', status: 'removed' });
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteRow);
    mockWrite.appListing.findUnique.mockResolvedValueOnce(offsiteRow);
    await purgeListing({
      input: { appListingId: APP_ID, reason: REASON },
      reviewerUserId: REVIEWER,
    });
    expect(mockNotify).not.toHaveBeenCalled();
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

  /**
   * 🔴 THE ONE THAT WAS VACUOUS. See {@link stageLiveSubmission} — the refusal is driven by an
   * `AppBlockPublishRequest` looked up BY SLUG, not by anything on the listing row.
   */
  it('refuses an on-site draft whose block request is still PENDING — by slug, on the right table', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(orphanDraft());
    stageLiveSubmission(true);

    // 🔴 NOT the generic NOT_FOUND the other refusals use. This surface is mod-only and the mod
    // table already shows this exact fact, so hiding it conceals nothing and would leave the
    // moderator at "not found" for a row visibly on screen. The message must say what to do.
    const err = await purgeListing({
      input: { appListingId: APP_ID, reason: REASON },
      reviewerUserId: REVIEWER,
    }).catch((e: Error & { code?: string }) => e);
    expect(err).toMatchObject({ code: 'NOT_TRANSITIONABLE' });
    expect((err as Error).message).toMatch(/reject or withdraw/i);

    // Refused at the replica classify — no tx, no event, no delete, no notification.
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
    expect(mockWrite.appListing.deleteMany).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();

    // 🔴 Pins WHICH TABLE and WHICH PREDICATE. A guard that queried the listing relation
    // instead would satisfy "refuses when a request is pending" against an impossible fixture
    // while permitting the real case — which is exactly what shipped before.
    expect(mockRead.appBlockPublishRequest.findFirst).toHaveBeenCalledWith({
      where: { slug: SLUG, status: 'pending' },
      select: { id: true },
    });
  });

  it('re-checks it on the PRIMARY inside the tx, not only on the replica', async () => {
    // Replica says no live submission; the primary sees one that landed in between.
    mockRead.appListing.findUnique.mockResolvedValueOnce(orphanDraft());
    mockWrite.appListing.findUnique.mockResolvedValueOnce(orphanDraft());
    mockRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    mockWrite.appBlockPublishRequest.findFirst.mockResolvedValue({ id: 'pubreq_raced' });

    await expect(
      purgeListing({ input: { appListingId: APP_ID, reason: REASON }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_TRANSITIONABLE' });

    // The tx opened, then rolled back BEFORE the audit event — zero events on a guarded refusal.
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
    expect(mockWrite.appListing.deleteMany).not.toHaveBeenCalled();
  });

  it('does NOT run the slug lookup for an OFF-SITE purge (its requests carry a real FK)', async () => {
    const offsiteRow = orphanDraft({ kind: 'offsite', status: 'removed' });
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteRow);
    mockWrite.appListing.findUnique.mockResolvedValueOnce(offsiteRow);
    await purgeListing({
      input: { appListingId: APP_ID, reason: REASON },
      reviewerUserId: REVIEWER,
    });
    expect(mockRead.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
    expect(mockWrite.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
  });

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
