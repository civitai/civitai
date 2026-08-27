import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { stripCommentsAndStrings } from '../../../../../test/strip-comments';
import {
  approveExternalRequest,
  rejectExternalRequest,
  submitListingRevision,
  listPendingOffsiteRequests,
  listApprovedOffsiteRequests,
  listRejectedOffsiteRequests,
} from '~/server/services/blocks/offsite-listing.service';

/**
 * W13 — ONSITE listing-media revision CONSOLIDATION service tests.
 *
 * The onsite half of the shadow-draft revision flow: an onsite app's `AppListing`
 * is auto-created (`kind:'onsite'`, `status:'approved'`); its media (icon/cover/
 * screenshots) is edited via the SAME begin/upload/submit shadow flow, then the
 * revision is CONSOLIDATED through the (now kind-widened) mod queue + approve/reject.
 *
 * These tests pin the genuinely-new onsite behavior + prove offsite is byte-identical:
 *   1. approve of an onsite media revision is ASSETS-ONLY — it copies the shadow's
 *      icon/cover/screenshots onto the live parent but PRESERVES the parent's
 *      manifest-governed scalars (name/tagline/description/category/contentRating),
 *      and does NOT derive/raise contentRating from the assets (cap-at-app-rating).
 *   2. reject deletes ONLY the onsite draft shadow; the live parent stays approved.
 *   3. the approve supersede scopes by the REQUEST's kind (offsite stays 'offsite';
 *      generalizes to 'onsite' so an onsite sibling is never stranded).
 *   4. the mod queue procs return onsite rows carrying `kind:'onsite'`; offsite rows
 *      are unchanged and the where-clause widens to kind IN ('onsite','offsite').
 *   5. REGRESSION GUARD: an offsite revision approve/reject is byte-identical (full
 *      scalar copy + asset-derived rating on approve; shadow-only delete on reject).
 *   6. INVARIANT: the only producer of a `kind='onsite'` AppListingPublishRequest is
 *      `submitListingRevision` on an onsite shadow (a media revision targeting a
 *      shadow, `revisionOfId != null`) — so widening the queue gates surfaces exactly
 *      media revisions, nothing else.
 *
 * All DB deps mocked in the sibling service-test style (no real Prisma).
 */

const { mockRead, mockWrite, seq } = vi.hoisted(() => {
  const makeClient = () => ({
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (args: { data: unknown }) => args.data),
      update: vi.fn(async (args: { data: unknown }) => args.data),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
      deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
    appListingScreenshot: {
      count: vi.fn(async (..._a: unknown[]) => 1),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      createMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
      deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
    appListingModerationEvent: {
      create: vi.fn(async (args: { data: unknown }) => args.data),
    },
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
  return { mockRead, mockWrite, seq: { n: 0 } };
});

const { mockNotify } = vi.hoisted(() => ({ mockNotify: vi.fn(async () => undefined) }));

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/server/services/blocks/app-listing-notify', () => ({
  notifyAppListingOwner: mockNotify,
}));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_new_${++seq.n}`,
  newAppListingPublishRequestId: () => `alpr_new_${++seq.n}`,
  newAppListingScreenshotId: () => `apls_new_${++seq.n}`,
  newAppListingModerationEventId: () => `alme_new_${++seq.n}`,
  newUlid: () => `ULID${++seq.n}`,
}));

const MOD = 7;
const CALLER = 42;

beforeEach(() => {
  vi.clearAllMocks();
  seq.n = 0;
  for (const c of [mockRead, mockWrite]) {
    c.appListing.findUnique.mockReset().mockResolvedValue(null);
    c.appListing.findFirst.mockReset().mockResolvedValue(null);
    c.appListing.create.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    c.appListing.update.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    c.appListing.updateMany.mockReset().mockResolvedValue({ count: 1 });
    c.appListing.deleteMany.mockReset().mockResolvedValue({ count: 1 });
    c.appListingScreenshot.count.mockReset().mockResolvedValue(1);
    c.appListingScreenshot.findMany.mockReset().mockResolvedValue([]);
    c.appListingScreenshot.createMany.mockReset().mockResolvedValue({ count: 0 });
    c.appListingScreenshot.deleteMany.mockReset().mockResolvedValue({ count: 0 });
    c.appListingScreenshot.updateMany.mockReset().mockResolvedValue({ count: 0 });
    c.appListingModerationEvent.create.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    // Default: the go-live scan-clean gate re-reads each asset's `ingestion` — echo
    // every queried id as `Scanned` so a normal approve passes. (The scan gate selects
    // `{ id, ingestion }`; the rating derive selects `{ nsfwLevel }` — tests that need a
    // specific level override this and add `ingestion: 'Scanned'`.)
    c.image.findMany
      .mockReset()
      .mockImplementation(async (args: { where?: { id?: { in?: number[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({ id, ingestion: 'Scanned' }))
      );
    c.appListingPublishRequest.findUnique.mockReset().mockResolvedValue(null);
    c.appListingPublishRequest.findFirst.mockReset().mockResolvedValue(null);
    c.appListingPublishRequest.findMany.mockReset().mockResolvedValue([]);
    c.appListingPublishRequest.create.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    c.appListingPublishRequest.updateMany.mockReset().mockResolvedValue({ count: 1 });
  }
  mockWrite.$transaction
    .mockReset()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
  mockNotify.mockReset().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Stagers: an ONSITE and an OFFSITE media-revision approve (revisionOfId set →
// applyApprovedRevision). The onsite parent's scalars MUST NOT be overwritten.
// ---------------------------------------------------------------------------

/** Stage a media-revision approve of the given kind. The shadow carries EDITED
 *  scalars (name/description) to prove they are ignored on the onsite branch. */
function stageRevisionApprove(kind: 'onsite' | 'offsite') {
  mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
    id: 'alpr_r',
    status: 'pending',
    kind,
    slug: 'my-app',
    appListingId: 'apl_shadow',
  });
  // Replica reads: the SHADOW (revisionOfId set → routes to applyApprovedRevision),
  // then the PARENT (still approved, carries `kind`).
  mockRead.appListing.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
    if (args.where.id === 'apl_shadow') {
      return {
        id: 'apl_shadow',
        status: 'draft',
        externalUrl: kind === 'offsite' ? 'https://example.com/' : null,
        iconId: 99,
        coverId: 88,
        revisionOfId: 'apl_parent',
        connectClientId: null,
        connectRequestedScopes: null,
        connectScopeJustifications: null,
        userId: CALLER,
        name: 'Edited Name',
        slug: 'my-app',
      };
    }
    if (args.where.id === 'apl_parent') {
      return { id: 'apl_parent', slug: 'my-app', status: 'approved', kind };
    }
    return null;
  });
  // In-tx (PRIMARY) shadow re-read: the edited scalars + the new assets.
  mockWrite.appListing.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
    if (args.where.id === 'apl_shadow') {
      return {
        id: 'apl_shadow',
        status: 'draft',
        revisionOfId: 'apl_parent',
        name: 'Edited Name',
        tagline: 'Edited tagline',
        description: 'Edited description',
        category: 'games',
        contentRating: 'x', // shadow declares a HIGH rating — must NOT flow onto an onsite parent
        externalUrl: kind === 'offsite' ? 'https://example.com/' : null,
        connectClientId: null,
        connectRequestedScopes: null,
        connectScopeJustifications: null,
        connectClient: null,
        iconId: 99,
        coverId: 88,
      };
    }
    return null;
  });
}

describe('approveExternalRequest — ONSITE media revision is ASSETS-ONLY (cap-at-app-rating)', () => {
  it('copies icon/cover onto the live parent but PRESERVES the parent scalars (no name/description/category/contentRating write)', async () => {
    stageRevisionApprove('onsite');
    const res = await approveExternalRequest({ publishRequestId: 'alpr_r', reviewerUserId: MOD });
    expect(res).toEqual({ publishRequestId: 'alpr_r', listingId: 'apl_parent', slug: 'my-app' });

    // The parent copy wrote ONLY the asset columns.
    const copy = mockWrite.appListing.update.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(copy.where).toEqual({ id: 'apl_parent' });
    expect(copy.data).toEqual({ iconId: 99, coverId: 88 });
    // 🔴 manifest-governed scalars are NOT touched.
    expect(copy.data).not.toHaveProperty('name');
    expect(copy.data).not.toHaveProperty('tagline');
    expect(copy.data).not.toHaveProperty('description');
    expect(copy.data).not.toHaveProperty('category');
    expect(copy.data).not.toHaveProperty('contentRating');
  });

  it('does NOT derive/raise contentRating from the shadow assets (resolveApprovalContentRating skipped → no nsfwLevel read)', async () => {
    stageRevisionApprove('onsite');
    await approveExternalRequest({ publishRequestId: 'alpr_r', reviewerUserId: MOD });
    // The go-live scan-clean gate DOES read image.findMany now (select {id,ingestion}),
    // but resolveApprovalContentRating (the asset-floor rating derive) — the ONLY reader
    // of Image nsfwLevel — must be skipped on the onsite branch. Assert NO call selected
    // nsfwLevel (which only the derive does).
    const derivedRead = mockWrite.image.findMany.mock.calls.find(
      (c) => (c[0] as { select?: { nsfwLevel?: unknown } })?.select?.nsfwLevel
    );
    expect(derivedRead).toBeUndefined();
    // A mod contentRating override is also ignored for the onsite branch.
  });

  it('an onsite contentRating override is ignored (still assets-only)', async () => {
    stageRevisionApprove('onsite');
    await approveExternalRequest({
      publishRequestId: 'alpr_r',
      reviewerUserId: MOD,
      contentRating: 'r',
    });
    const copy = mockWrite.appListing.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(copy.data).toEqual({ iconId: 99, coverId: 88 });
    expect(copy.data).not.toHaveProperty('contentRating');
  });

  it('reparents the shadow screenshots onto the parent + retires the shadow (kind-agnostic reuse)', async () => {
    stageRevisionApprove('onsite');
    await approveExternalRequest({ publishRequestId: 'alpr_r', reviewerUserId: MOD });
    // Parent's old rows dropped, shadow rows moved to the parent, shadow deleted.
    expect(mockWrite.appListingScreenshot.deleteMany).toHaveBeenCalledWith({
      where: { appListingId: 'apl_parent' },
    });
    expect(mockWrite.appListingScreenshot.updateMany).toHaveBeenCalledWith({
      where: { appListingId: 'apl_shadow' },
      data: { appListingId: 'apl_parent' },
    });
    expect(mockWrite.appListing.deleteMany).toHaveBeenCalledWith({
      where: { id: 'apl_shadow', revisionOfId: { not: null } },
    });
    // A revision approve does NOT notify (the parent stayed live).
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe('approveExternalRequest — OFFSITE revision approve is BYTE-IDENTICAL (regression guard)', () => {
  it('copies the FULL scalar set onto the parent + DERIVES the rating from assets', async () => {
    stageRevisionApprove('offsite');
    const res = await approveExternalRequest({ publishRequestId: 'alpr_r', reviewerUserId: MOD });
    expect(res).toEqual({ publishRequestId: 'alpr_r', listingId: 'apl_parent', slug: 'my-app' });

    const copy = mockWrite.appListing.update.mock.calls[0][0] as { data: Record<string, unknown> };
    // The offsite branch still copies name/tagline/description/category + assets.
    expect(copy.data).toMatchObject({
      name: 'Edited Name',
      tagline: 'Edited tagline',
      description: 'Edited description',
      category: 'games',
      externalUrl: 'https://example.com/',
      iconId: 99,
      coverId: 88,
    });
    // contentRating is present (asset-DERIVED, floored) — the offsite path stamps it.
    expect(copy.data).toHaveProperty('contentRating');
    // The asset-floor derivation DID read Image levels (proves resolveApprovalContentRating ran).
    expect(mockWrite.image.findMany).toHaveBeenCalled();
  });
});

describe('rejectExternalRequest — ONSITE revision deletes ONLY the shadow (parent stays live)', () => {
  it('deletes the draft shadow, never flips the parent, writes no delist event, sends no owner notice', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_r',
      status: 'pending',
      kind: 'onsite',
      appListingId: 'apl_shadow',
    });
    // Snapshot read (owner/name/slug/revisionOfId) — revisionOfId set ⇒ a revision reject.
    mockRead.appListing.findUnique.mockResolvedValue({
      userId: CALLER,
      name: 'My App',
      slug: 'rev-abc',
      revisionOfId: 'apl_parent',
    });
    // closeTerminalListing reads the listing status via the tx (write) client.
    mockWrite.appListing.findUnique.mockResolvedValue({ status: 'draft', slug: 'rev-abc' });

    await rejectExternalRequest({
      publishRequestId: 'alpr_r',
      reviewerUserId: MOD,
      rejectionReason: 'blurry screenshots',
    });

    // The request flipped to rejected …
    expect(mockWrite.appListingPublishRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'alpr_r', status: 'pending' },
        data: expect.objectContaining({ status: 'rejected' }),
      })
    );
    // … and ONLY the draft shadow was deleted (status-guarded).
    expect(mockWrite.appListing.deleteMany).toHaveBeenCalledWith({
      where: { id: 'apl_shadow', status: 'draft' },
    });
    // The parent was never flipped (no pending→removed) and no delist event written
    // (that's the reset-to-pending branch, not a draft shadow).
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
    // A revision reject sends NO "your app was not approved" notice (parent still live).
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe('approveExternalRequest — supersede scopes by the REQUEST kind (no onsite sibling stranded)', () => {
  /**
   * Stage a FIRST-TIME (non-revision) approve of the given kind so the main-body
   * supersede runs. Offsite is the real production path; the onsite case pins the
   * generalization defensively — the invariant means onsite normally routes to the
   * revision-apply path, but IF the main-body supersede is reached its kind filter
   * must follow `request.kind`, never a hard-coded 'offsite' (else an onsite sibling
   * on the same listing would be left pending / stranded).
   */
  function stageFirstTimeApprove(kind: 'onsite' | 'offsite') {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_ft',
      status: 'pending',
      kind,
      slug: 'app',
      appListingId: 'apl_ft',
    });
    mockRead.appListing.findUnique.mockResolvedValue({
      id: 'apl_ft',
      status: 'draft',
      kind,
      externalUrl: kind === 'offsite' ? 'https://example.com/' : null,
      iconId: 1,
      coverId: 2,
      revisionOfId: null, // NON-revision → main-body flip + supersede
      connectClientId: null,
      connectRequestedScopes: null,
      connectScopeJustifications: null,
      userId: CALLER,
      name: 'App',
      slug: 'app',
    });
    mockWrite.appListing.findUnique.mockResolvedValue({
      externalUrl: kind === 'offsite' ? 'https://example.com/' : null,
      iconId: 1,
      coverId: 2,
      connectClientId: null,
      connectRequestedScopes: null,
      connectScopeJustifications: null,
      connectClient: null,
    });
  }

  it('offsite first-time approve supersedes siblings scoped kind:offsite (byte-identical)', async () => {
    stageFirstTimeApprove('offsite');
    await approveExternalRequest({ publishRequestId: 'alpr_ft', reviewerUserId: MOD });
    // Two publishRequest.updateMany calls: [0] the status flip, [1] the supersede.
    const supersede = mockWrite.appListingPublishRequest.updateMany.mock.calls[1][0] as {
      where: Record<string, unknown>;
    };
    expect(supersede.where).toMatchObject({
      appListingId: 'apl_ft',
      status: 'pending',
      kind: 'offsite',
      NOT: { id: 'alpr_ft' },
    });
  });

  it('onsite (defensive main-body) approve supersedes siblings scoped kind:onsite — not hard-coded offsite', async () => {
    stageFirstTimeApprove('onsite');
    await approveExternalRequest({ publishRequestId: 'alpr_ft', reviewerUserId: MOD });
    const supersede = mockWrite.appListingPublishRequest.updateMany.mock.calls[1][0] as {
      where: Record<string, unknown>;
    };
    expect(supersede.where).toMatchObject({
      appListingId: 'apl_ft',
      status: 'pending',
      kind: 'onsite',
      NOT: { id: 'alpr_ft' },
    });
  });
});

describe('mod queue procs — widened to kind IN (onsite, offsite), each row carries kind', () => {
  it('listPendingOffsiteRequests: where widens to both kinds, select carries kind, onsite rows surface with kind:onsite', async () => {
    mockRead.appListingPublishRequest.findMany.mockResolvedValue([
      { id: 'a', kind: 'onsite', slug: 'x', status: 'pending', appListingId: 'apl_s', appListing: {} },
      { id: 'b', kind: 'offsite', slug: 'y', status: 'pending', appListingId: 'apl_o', appListing: {} },
    ]);
    const res = await listPendingOffsiteRequests({});
    const call = mockRead.appListingPublishRequest.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(call.where).toMatchObject({ status: 'pending', kind: { in: ['onsite', 'offsite'] } });
    // The request kind is selected so PR-2 can badge the row.
    expect(call.select.kind).toBe(true);
    expect(res.items.map((r: { kind: string }) => r.kind)).toEqual(['onsite', 'offsite']);
  });

  it('🔴 every mod queue projects appListing.revisionOfId — the review drift panel’s only handle on the LIVE parent', async () => {
    // A revision request's `appListingId` IS the shadow id, so `revisionOfId` is the
    // ONLY way the review surface can reach the listing that is currently being
    // served. Drop it and `RevisionDriftSection` silently renders nothing: the mod is
    // back to approving a destructive screenshot replace with no before/after — the
    // gap this projection exists to close. Guarded on all three queues because the
    // history tabs render the same modal body.
    await listPendingOffsiteRequests({});
    await listApprovedOffsiteRequests({});
    await listRejectedOffsiteRequests({});
    const selects = mockRead.appListingPublishRequest.findMany.mock.calls.map(
      (c) =>
        (c[0] as { select: { appListing: { select: Record<string, unknown> } } }).select.appListing
          .select
    );
    expect(selects).toHaveLength(3);
    for (const select of selects) expect(select.revisionOfId).toBe(true);
  });

  it('listApprovedOffsiteRequests + listRejectedOffsiteRequests both widen the kind filter', async () => {
    await listApprovedOffsiteRequests({});
    await listRejectedOffsiteRequests({});
    const approvedWhere = (mockRead.appListingPublishRequest.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    const rejectedWhere = (mockRead.appListingPublishRequest.findMany.mock.calls[1][0] as { where: Record<string, unknown> }).where;
    expect(approvedWhere).toMatchObject({ status: 'approved', kind: { in: ['onsite', 'offsite'] } });
    expect(rejectedWhere).toMatchObject({ status: 'rejected', kind: { in: ['onsite', 'offsite'] } });
  });
});

/**
 * 🔴 PRODUCER LEDGER for `AppListingPublishRequest`.
 *
 * `offsite-listing.service` used to carry a one-sentence INVARIANT above
 * `REVIEWABLE_LISTING_KINDS`: *"the ONLY producer of a `kind='onsite'`
 * `AppListingPublishRequest` is `submitListingRevision` on an onsite SHADOW"*. Six
 * consumers of that constant reason from it, and it is what justifies
 * `listMySubmissions`'s unconditional `{ kind: 'onsite' }` OR-branch.
 *
 * It went FALSE — the owner-republish asset-review route mints a NON-SHADOW onsite
 * request — and the test named for it stayed green the whole time, because it asserted
 * only that `submitListingRevision` produces a well-shaped row. Proving one member of a
 * set is in it says nothing about whether the set has grown. So the shape assertion is
 * kept below (it pins the VALUES) and this ledger is added beside it to pin the
 * POPULATION: it enumerates every production site that creates a row in that table and
 * FAILS when the set GROWS (a producer added without a decision recorded) **or** SHRINKS
 * (one removed or renamed and the reasoning here went stale).
 *
 * Test files are out of scope — a test may construct any row for any reason.
 */
const LISTING_REQUEST_PRODUCERS: Record<string, string> = {
  'src/server/services/blocks/offsite-listing.service.ts::submitExternalListing':
    "OFF-SITE only (`kind: 'offsite'`), NON-shadow — a first-time off-site store " +
    'submission, minted alongside the draft listing it targets.',
  'src/server/services/blocks/offsite-listing.service.ts::submitListingRevision':
    'BOTH kinds, always SHADOW (`revisionOfId` set on the target listing; the PARENT ' +
    'slug is denormalized onto the request). This is the producer the old invariant ' +
    'sentence named, and for on-site it was once the only one.',
  'src/server/services/blocks/offsite-moderation.service.ts::resetListingToPending':
    'OFF-SITE only, NON-shadow — the moderator reset. The ON-SITE reset is a different ' +
    'function (`resetOnsiteListingToPending`) and re-queues on `AppBlockPublishRequest`, ' +
    'which is why the on-site half of this table was shadow-only.',
  'src/server/services/blocks/offsite-moderation.service.ts::routeRepublishToReviewInTx':
    '🔴 THE SECOND ON-SITE PRODUCER, and the one that falsified the invariant. BOTH ' +
    "kinds (`kind: listing.kind`), NON-shadow — an owner republish whose assets differ " +
    'from the recorded approval baseline. Any consumer that reads `kind:onsite` as ' +
    '"therefore a shadow revision" is wrong about this row; discriminate on ' +
    '`revisionOfId`, never on `kind`.',
};

describe('🔴 AppListingPublishRequest PRODUCER LEDGER — fails when the set grows or shrinks', () => {
  const ROOT = process.cwd();
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  };
  const FILES = walk(join(ROOT, 'src'))
    .map((f) => relative(ROOT, f).split(sep).join('/'))
    .filter((f) => !/__tests__|\.test\.tsx?$|(^|\/)src\/tests\//.test(f));

  /** `<file>::<enclosing top-level function>` for every `…PublishRequest.create(` site. */
  const findProducers = (needle: RegExp) => {
    const found: string[] = [];
    for (const file of FILES) {
      // Comments and string literals stripped: this codebase discusses these tables at
      // length in prose, and only real code is a producer.
      const code = stripCommentsAndStrings(readFileSync(join(ROOT, file), 'utf8'));
      for (const m of code.matchAll(needle)) {
        const before = code.slice(0, m.index);
        const decls = [
          ...before.matchAll(/^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+) = /gm),
        ];
        const last = decls[decls.length - 1];
        const fn = last ? last[1] ?? last[2] : '<module scope>';
        found.push(`${file}::${fn}`);
      }
    }
    return [...new Set(found)].sort();
  };

  const PRODUCERS = findProducers(/appListingPublishRequest\.create\(/g);

  it('POSITIVE CONTROL: the scan enumerates a real population and can match', () => {
    // A broken walk, a wrong regex or a stripper that ate the file would make the ledger
    // assertion vacuously true. Prove the instrument works before reading its verdict.
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain('src/server/services/blocks/offsite-listing.service.ts');
    expect(PRODUCERS.length).toBeGreaterThan(1);
  });

  it('NEGATIVE CONTROL: a definitely-absent producer matches nothing', () => {
    expect(findProducers(/appListingPublishRequestNoSuchTable\.create\(/g)).toEqual([]);
  });

  it('🔴 the producer set is EXACTLY the ledger', () => {
    expect(PRODUCERS).toEqual(Object.keys(LISTING_REQUEST_PRODUCERS).sort());
  });

  it('🔴 the on-site half is NO LONGER shadow-only — at least two producers can emit kind:onsite', () => {
    // The claim the stale sentence made, stated so it can be checked: a producer emits
    // on-site rows when it writes `kind: 'onsite'` or forwards a listing's own kind.
    const onsiteCapable = Object.keys(LISTING_REQUEST_PRODUCERS).filter((k) =>
      /BOTH kinds/.test(LISTING_REQUEST_PRODUCERS[k])
    );
    expect(onsiteCapable.sort()).toEqual([
      'src/server/services/blocks/offsite-listing.service.ts::submitListingRevision',
      'src/server/services/blocks/offsite-moderation.service.ts::routeRepublishToReviewInTx',
    ]);
  });

  it('🔴 `routeRepublishToReviewInTx` really does forward the listing kind (not a hardcoded offsite)', () => {
    // The ledger entry above is prose; this is the code it describes. Without it the
    // ledger could record a producer that does not actually reach the on-site half.
    const code = stripCommentsAndStrings(
      readFileSync(
        join(ROOT, 'src/server/services/blocks/offsite-moderation.service.ts'),
        'utf8'
      )
    );
    const fnStart = code.indexOf('function routeRepublishToReviewInTx');
    expect(fnStart).toBeGreaterThan(-1); // the ledger key must still name a real function
    const body = code.slice(fnStart);
    const create = body.slice(body.indexOf('appListingPublishRequest.create('));
    expect(create.slice(0, 400)).toContain('kind: listing.kind');
    // …and the sibling that is genuinely off-site-only still hardcodes it, so the
    // assertion above is discriminating rather than matching any create in the file.
    // 🔴 Read from the RAW source here, not the stripped copy: the value under test IS a
    // string literal, and `stripCommentsAndStrings` blanks it to `kind:  ,` — asserting
    // against the stripped text would be asserting the stripper's output.
    const raw = readFileSync(
      join(ROOT, 'src/server/services/blocks/offsite-moderation.service.ts'),
      'utf8'
    );
    const reset = raw.slice(raw.indexOf('async function resetListingToPending'));
    const resetCreate = reset.slice(reset.indexOf('appListingPublishRequest.create('));
    expect(resetCreate.slice(0, 400)).toContain("kind: 'offsite'");
  });
});

describe('the shape of a kind:onsite AppListingPublishRequest minted by submitListingRevision', () => {
  it('submitListingRevision on an onsite shadow mints a kind:onsite request targeting the shadow (revisionOfId set)', async () => {
    // The shadow: a draft revision of an approved onsite parent (revisionOfId set).
    mockRead.appListing.findUnique.mockResolvedValue({
      id: 'apl_shadow',
      kind: 'onsite',
      status: 'draft',
      userId: CALLER,
      revisionOfId: 'apl_parent', // ⇐ a SHADOW, never a top-level listing
      externalUrl: null,
      iconId: 99,
      coverId: 88,
      revisionOf: { slug: 'my-app', status: 'approved' },
    });
    // Asset-complete (dbWrite screenshot count) + no open request yet.
    mockWrite.appListingScreenshot.count.mockResolvedValue(1);
    mockRead.appListingPublishRequest.findFirst.mockResolvedValue(null);

    const res = await submitListingRevision({ shadowId: 'apl_shadow', userId: CALLER });
    expect(res).toMatchObject({ shadowId: 'apl_shadow', slug: 'my-app' });

    const created = mockWrite.appListingPublishRequest.create.mock.calls[0][0].data as Record<string, unknown>;
    // 🔴 the request is kind:onsite AND points at the SHADOW — so widening the queue
    // gates to include onsite surfaces exactly media revisions, nothing else.
    expect(created.kind).toBe('onsite');
    expect(created.appListingId).toBe('apl_shadow');
    // The public PARENT slug is denormalized so the queue reads the live slug.
    expect(created.slug).toBe('my-app');
    expect(created.status).toBe('pending');
  });
});
