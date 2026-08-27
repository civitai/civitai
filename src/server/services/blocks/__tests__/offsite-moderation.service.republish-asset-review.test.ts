import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NsfwLevel } from '~/server/common/enums';
import {
  OffsiteModerationError,
  republishOwnListing,
  unpublishOwnListing,
} from '~/server/services/blocks/offsite-moderation.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
// The onsite drift warn is a dynamic import of the logging client; the canonical
// mock keeps that graph out of this suite.
import '~/__tests__/mocks/logging.mock';
const mockRead = dbMock.dbRead;
const mockWrite = dbMock.dbWrite;

/**
 * 🔴 THE OWNER-REPUBLISH ASSET-CHANGE REVIEW GATE.
 *
 * An owner may `unpublishOwnListing` their own approved listing, swap the icon / cover /
 * screenshots (a `removed` listing is directly asset-editable) and republish. Before this
 * gate that put brand-new store-card imagery live with NO content review — the existing
 * go-live gates read scan STATUS, the destination href and MATURITY, none of which is a
 * review.
 *
 * The gate compares the listing's CURRENT asset surface against the one recorded into the
 * `owner-unpublish` event when the owner took it down (= what a moderator last approved).
 * Changed, or no baseline at all, ⇒ route to `pending` + re-queue. Unchanged ⇒ immediate,
 * byte-for-behaviour as before.
 *
 * All DB deps are mocked; `dbWrite.$transaction` runs its callback against the SAME write
 * mock, so `tx.*` calls land on the same spies and a guarded 0-count can be asserted to
 * abort BEFORE any audit event is written.
 */

type WriteMock = {
  $transaction: ReturnType<typeof vi.fn>;
  appListing: {
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  appBlock: { updateMany: ReturnType<typeof vi.fn> };
  appListingModerationEvent: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  appListingPublishRequest: { create: ReturnType<typeof vi.fn> };
  appBlockPublishRequest: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  appListingScreenshot: { findMany: ReturnType<typeof vi.fn> };
  image: { findMany: ReturnType<typeof vi.fn> };
};

const { mockNotify, ids } = vi.hoisted(() => {
  return {
    mockNotify: vi.fn(async () => undefined),
    ids: { n: 0 },
  };
});

vi.mock('~/server/services/blocks/app-listing-notify', () => ({
  notifyAppListingOwner: mockNotify,
}));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingModerationEventId: () => `alme_test_${++ids.n}`,
  newAppListingPublishRequestId: () => `alpr_test_${++ids.n}`,
  newAppListingReportId: () => `alrp_test_${++ids.n}`,
  newAppOwnershipEventId: () => `aoe_test_${++ids.n}`,
  newUlid: () => `ULIDTEST${++ids.n}`,
}));

const APP_ID = 'apl_target';
const SLUG = 'cool-app';
const OWNER = 500;
const BLOCK_ID = 'apb_backing';
const EXTERNAL_URL = 'https://cool.app';

/** Pairwise-DISTINCT asset ids, so a mutant that confuses two fields cannot pass. */
const ICON_ID = 11;
const COVER_ID = 22;
const SHOT_ID = 33;

type Shot = { imageId: number; order: number; caption: string | null };

const shot = (imageId: number, order = 0, caption: string | null = null): Shot => ({
  imageId,
  order,
  caption,
});

/** The listing row `loadOwnedListingInTx` returns (the FIRST `appListing.findUnique`). */
function ownedListing(
  over: {
    kind?: string;
    iconId?: number | null;
    coverId?: number | null;
    contentRating?: string | null;
  } = {}
) {
  const kind = over.kind ?? 'offsite';
  return {
    userId: OWNER,
    status: 'removed',
    kind,
    slug: SLUG,
    name: 'Cool App',
    appBlockId: kind === 'onsite' ? BLOCK_ID : null,
    contentRating: over.contentRating === undefined ? 'g' : over.contentRating,
    iconId: over.iconId === undefined ? ICON_ID : over.iconId,
    coverId: over.coverId === undefined ? COVER_ID : over.coverId,
    externalUrl: kind === 'offsite' ? EXTERNAL_URL : null,
    connectClientId: null,
  };
}

/** The baseline shape `unpublishOwnListing` writes into `owner-unpublish.before.assets`. */
const baseline = (
  over: {
    iconId?: number | null;
    coverId?: number | null;
    screenshots?: { imageId: number; caption: string | null }[];
  } = {}
) => ({
  v: 1,
  iconId: over.iconId === undefined ? ICON_ID : over.iconId,
  coverId: over.coverId === undefined ? COVER_ID : over.coverId,
  screenshots: over.screenshots ?? [{ imageId: SHOT_ID, caption: null }],
});

/**
 * Stage a republish: the owned listing, the live screenshots, and the recorded baseline.
 *
 * `recorded: undefined` means "the event carries no snapshot at all" — the legacy arm.
 */
function wire(opts: {
  kind?: string;
  iconId?: number | null;
  coverId?: number | null;
  contentRating?: string | null;
  shots?: Shot[];
  recorded?: unknown;
  levels?: Record<number, number>;
  lastAction?: string;
}) {
  const shots = opts.shots ?? [shot(SHOT_ID)];
  const levels = opts.levels ?? {};
  const listing = ownedListing(opts);

  // Read 1 = loadOwnedListingInTx; every later read (scan gate, actionability, rating
  // floor) takes the blanket value, which carries the same asset ids + the kind/url the
  // actionability gate needs. A thinner blanket would silently DISARM that gate.
  mockWrite.appListing.findUnique.mockReset().mockResolvedValue(listing);
  mockWrite.appListing.findUnique.mockResolvedValueOnce(listing);
  mockWrite.appListingScreenshot.findMany
    .mockReset()
    .mockImplementation(async (args: { where?: { imageId?: unknown } }) =>
      // The scan gate + the rating floor select `imageId: { not: null }`; the snapshot
      // builder selects every row. Honour the filter so both see what they expect.
      args?.where?.imageId ? shots.filter((s) => s.imageId != null) : shots
    );
  mockWrite.image.findMany
    .mockReset()
    .mockImplementation(async (args: { where?: { id?: { in?: number[] } } }) =>
      (args?.where?.id?.in ?? []).map((id) => ({
        id,
        ingestion: 'Scanned',
        nsfwLevel: levels[id] ?? NsfwLevel.PG,
      }))
    );
  mockWrite.appListingModerationEvent.findFirst.mockReset().mockResolvedValue(
    'lastAction' in opts && opts.lastAction !== 'owner-unpublish'
      ? { action: opts.lastAction, before: { status: 'approved' } }
      : {
          action: 'owner-unpublish',
          before:
            'recorded' in opts
              ? { status: 'approved', assets: opts.recorded }
              : { status: 'approved', assets: baseline() },
        }
  );
}

/** The `data` of the guarded `removed → …` status flip. */
function flipData() {
  const call = mockWrite.appListing.updateMany.mock.calls.find(
    (c: [{ where?: { status?: string } }]) => c[0]?.where?.status === 'removed'
  );
  return call?.[0]?.data;
}

/** The single moderation event the republish wrote. */
function eventData() {
  return mockWrite.appListingModerationEvent.create.mock.calls[0]?.[0]?.data;
}

/** The approved block request the onsite re-queue clones. */
const lastApprovedBlockRequest = {
  appBlockId: BLOCK_ID,
  version: '1.2.0',
  manifest: { blockId: SLUG, scopes: [] },
  bundleKey: 'bundles/deadbeef.zip',
  bundleSha256: 'deadbeef',
  bundleSizeBytes: BigInt(1024),
  fileSummary: { files: [], added: [], removed: [], changed: [] },
  manifestDiffSummary: { kind: 'update' },
  forgejoCommitSha: 'sha_server_side',
  sourceCommit: '4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3',
  sourceDirty: true,
};

beforeEach(() => {
  ids.n = 0;
  vi.clearAllMocks();
  mockWrite.$transaction.mockImplementation(async (cb: (tx: WriteMock) => Promise<unknown>) =>
    cb(mockWrite)
  );
  mockWrite.appListing.updateMany.mockResolvedValue({ count: 1 });
  mockWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });
  mockWrite.appListingModerationEvent.create.mockImplementation(
    async (a: { data: unknown }) => a.data
  );
  mockWrite.appListingPublishRequest.create.mockImplementation(
    async (a: { data: unknown }) => a.data
  );
  mockWrite.appBlockPublishRequest.create.mockImplementation(
    async (a: { data: unknown }) => a.data
  );
  // Onsite default: one approved version to clone, no review already in flight.
  mockWrite.appBlockPublishRequest.findFirst
    .mockResolvedValueOnce(lastApprovedBlockRequest)
    .mockResolvedValueOnce(null);
  mockRead.appListing.findUnique.mockResolvedValue(null);
  mockNotify.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// The IMMEDIATE arm — unchanged assets must behave exactly as they did before.
// ---------------------------------------------------------------------------

describe('republishOwnListing — assets UNCHANGED ⇒ immediate (no behaviour change)', () => {
  it('goes live, writes no re-review artifact, and reports `approved` with no reviewReason', async () => {
    wire({ recorded: baseline() });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });

    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
    expect(flipData()).toEqual({ status: 'approved', contentRating: 'g' });
    expect(mockWrite.appListingPublishRequest.create).not.toHaveBeenCalled();
    expect(mockWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
    expect(eventData()).toMatchObject({
      action: 'owner-republish',
      before: { status: 'removed' },
      after: { status: 'approved' },
    });
    expect(eventData().detail).toBeUndefined();
  });

  it('🔴 a screenshot RENUMBER with no reorder is still immediate (no false positive)', async () => {
    // Baseline recorded at order 0/1; live rows renumbered 10/20 in the same sequence.
    wire({
      shots: [shot(SHOT_ID, 10), shot(44, 20)],
      recorded: baseline({
        screenshots: [
          { imageId: SHOT_ID, caption: null },
          { imageId: 44, caption: null },
        ],
      }),
    });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res.status).toBe('approved');
  });

  it('🔴 a whitespace-only caption edit is still immediate (no false positive)', async () => {
    wire({
      shots: [shot(SHOT_ID, 0, '  hello  ')],
      recorded: baseline({ screenshots: [{ imageId: SHOT_ID, caption: 'hello' }] }),
    });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res.status).toBe('approved');
  });

  it('ON-SITE unchanged: restores the backing block, exactly as before', async () => {
    wire({ kind: 'onsite', recorded: baseline() });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res.status).toBe('approved');
    expect(mockWrite.appBlock.updateMany).toHaveBeenCalledWith({
      where: { id: BLOCK_ID, status: 'suspended' },
      data: { status: 'approved' },
    });
  });
});

// ---------------------------------------------------------------------------
// The REVIEW arm.
// ---------------------------------------------------------------------------

describe('republishOwnListing — assets CHANGED ⇒ routed to review', () => {
  it.each([
    ['the ICON was swapped', { iconId: 99 }, undefined],
    ['the ICON was cleared', { iconId: null }, undefined],
    ['the COVER was swapped', { coverId: 99 }, undefined],
    ['an ICON was ADDED where there was none', { iconId: ICON_ID }, { iconId: null }],
  ])('%s', async (_label, listingOver, baselineOver) => {
    wire({ ...listingOver, recorded: baseline(baselineOver ?? {}) });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res).toEqual({
      appListingId: APP_ID,
      status: 'pending',
      reviewReason: 'assets-changed',
    });
  });

  it.each([
    ['a screenshot IMAGE was swapped', [shot(99)], [{ imageId: SHOT_ID, caption: null }]],
    ['a screenshot was ADDED', [shot(SHOT_ID), shot(44, 1)], [{ imageId: SHOT_ID, caption: null }]],
    ['every screenshot was REMOVED', [], [{ imageId: SHOT_ID, caption: null }]],
    [
      'a screenshot CAPTION was rewritten',
      [shot(SHOT_ID, 0, 'buy now')],
      [{ imageId: SHOT_ID, caption: 'a demo' }],
    ],
    [
      'two screenshots were REORDERED',
      [shot(44, 0), shot(SHOT_ID, 1)],
      [
        { imageId: SHOT_ID, caption: null },
        { imageId: 44, caption: null },
      ],
    ],
  ])('%s', async (_label, shots, recordedShots) => {
    wire({ shots: shots as Shot[], recorded: baseline({ screenshots: recordedShots as never }) });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res.status).toBe('pending');
    expect(res.reviewReason).toBe('assets-changed');
  });

  it('OFF-SITE: flips to pending, mints an owner-submitted pending request, writes the audit event', async () => {
    wire({ iconId: 99, recorded: baseline() });
    await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });

    // The flip is status + kind guarded and carries the (floored) rating.
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'offsite', status: 'removed' },
      data: { status: 'pending', contentRating: 'g' },
    });
    // Re-queued as a NON-shadow request owned by the LISTING OWNER — the shape
    // `approveExternalRequest`'s widened `{draft,pending}` guard re-approves.
    expect(mockWrite.appListingPublishRequest.create).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListingPublishRequest.create.mock.calls[0][0].data).toMatchObject({
      appListingId: APP_ID,
      kind: 'offsite',
      slug: SLUG,
      submittedByUserId: OWNER,
      status: 'pending',
    });
    // The history says it went to REVIEW, not live, and says why.
    expect(mockWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(1);
    expect(eventData()).toMatchObject({
      appListingId: APP_ID,
      slug: SLUG,
      action: 'owner-republish',
      actorUserId: OWNER,
      before: { status: 'removed' },
      after: { status: 'pending' },
    });
    expect(eventData().detail).toContain('changed since the last approval');
    // No block to touch on an off-site listing.
    expect(mockWrite.appBlock.updateMany).not.toHaveBeenCalled();
  });

  it('🔴 ON-SITE: clones the approved block request and LEAVES THE BLOCK SUSPENDED', async () => {
    wire({ kind: 'onsite', iconId: 99, recorded: baseline() });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });

    expect(res.status).toBe('pending');
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'onsite', status: 'removed' },
      data: { status: 'pending', contentRating: 'g' },
    });
    // 🔴 THE LOAD-BEARING ABSENCE: an app awaiting review of its store card must NOT be
    // serving. `approveRequest`'s (3b-reset) branch un-suspends it on re-approve, gated
    // on exactly the `pending` listing status written above.
    expect(mockWrite.appBlock.updateMany).not.toHaveBeenCalled();
    // Re-queued through the BLOCK request table (the onsite review queue), owner-submitted,
    // carrying the approved version's bytes + provenance verbatim.
    expect(mockWrite.appBlockPublishRequest.create).toHaveBeenCalledTimes(1);
    expect(mockWrite.appBlockPublishRequest.create.mock.calls[0][0].data).toMatchObject({
      appBlockId: BLOCK_ID,
      slug: SLUG,
      submittedByUserId: OWNER,
      status: 'pending',
      version: '1.2.0',
      bundleSha256: 'deadbeef',
      sourceCommit: lastApprovedBlockRequest.sourceCommit,
      sourceDirty: true,
    });
    // The off-site listing-request table is NOT the onsite queue — writing there would
    // strand the app where no moderator looks.
    expect(mockWrite.appListingPublishRequest.create).not.toHaveBeenCalled();
  });

  it('🔴 ON-SITE with NO approved version to clone → NOT_TRANSITIONABLE, and NOTHING is written', async () => {
    // Stranding the listing in `pending` with nothing in any queue would be unrecoverable
    // for the owner, so the whole republish must refuse instead.
    wire({ kind: 'onsite', iconId: 99, recorded: baseline() });
    mockWrite.appBlockPublishRequest.findFirst.mockReset().mockResolvedValue(null);
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({
      name: 'OffsiteModerationError',
      code: 'NOT_TRANSITIONABLE',
      message: expect.stringContaining('no approved version'),
    });
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('🔴 ON-SITE with a review already in flight → NOT_TRANSITIONABLE, and NOTHING is written', async () => {
    wire({ kind: 'onsite', iconId: 99, recorded: baseline() });
    mockWrite.appBlockPublishRequest.findFirst
      .mockReset()
      .mockResolvedValueOnce(lastApprovedBlockRequest)
      .mockResolvedValueOnce({ id: 'pubreq_open' });
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({
      code: 'NOT_TRANSITIONABLE',
      message: expect.stringContaining('already pending'),
    });
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
  });

  it('a raced 0-count on the pending flip aborts BEFORE any audit event or queue entry', async () => {
    wire({ iconId: 99, recorded: baseline() });
    mockWrite.appListing.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'NOT_TRANSITIONABLE' });
    expect(mockWrite.appListingPublishRequest.create).not.toHaveBeenCalled();
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 🔴 The FAIL-CLOSED arm: no usable baseline.
// ---------------------------------------------------------------------------

describe('republishOwnListing — 🔴 NO usable baseline ⇒ review, never a silent pass', () => {
  it('a legacy `owner-unpublish` event with no recorded assets routes to review', async () => {
    // The whole population of listings unpublished BEFORE the snapshot shipped.
    wire({ iconId: 99, recorded: undefined });
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValue({
      action: 'owner-unpublish',
      before: { status: 'approved' },
    });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res).toEqual({
      appListingId: APP_ID,
      status: 'pending',
      reviewReason: 'no-recorded-assets',
    });
    expect(eventData().detail).toContain('no recorded assets');
  });

  it('🔴 an ASSET-LESS listing with no baseline ALSO routes to review', async () => {
    // The case a coercing parser gets wrong: an "empty" snapshot compares EQUAL to a
    // listing with no assets, so unknown would silently read as unchanged and go live.
    wire({ iconId: null, coverId: null, shots: [] });
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValue({
      action: 'owner-unpublish',
      before: { status: 'approved' },
    });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res.status).toBe('pending');
    expect(res.reviewReason).toBe('no-recorded-assets');
  });

  it.each([
    ['a FUTURE snapshot version', { v: 2, iconId: ICON_ID, coverId: COVER_ID, screenshots: [] }],
    ['a malformed payload', { v: 1, iconId: 'eleven', coverId: COVER_ID, screenshots: [] }],
    ['a non-object payload', 'approved'],
  ])('%s is UNKNOWN, not empty → review', async (_label, recorded) => {
    wire({ recorded });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res.reviewReason).toBe('no-recorded-assets');
  });
});

// ---------------------------------------------------------------------------
// Composition with the pre-existing gates.
// ---------------------------------------------------------------------------

describe('republishOwnListing — composition with the gates that were already there', () => {
  it('🔴 the mod-takedown guard still wins: a `delist` last event is FORBIDDEN, gate never runs', async () => {
    wire({ iconId: 99, lastAction: 'delist' });
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListingPublishRequest.create).not.toHaveBeenCalled();
  });

  it('the scan-clean gate still refuses a Blocked asset — even on the review arm', async () => {
    wire({ iconId: 99, recorded: baseline() });
    mockWrite.image.findMany.mockImplementation(
      async (args: { where?: { id?: { in?: number[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({
          id,
          ingestion: id === 99 ? 'Blocked' : 'Scanned',
          nsfwLevel: NsfwLevel.PG,
        }))
    );
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('blocked') });
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
  });

  it('🔴 #4418 RATING FLOOR is applied on the REVIEW arm too, not deferred to the approve', async () => {
    // Declared `g`, an X-rated cover swapped in. On-site is the case that matters most:
    // `approveRequest`'s (3b-reset) restore writes ONLY `status` and runs no floor of its
    // own, so a review arm that skipped the floor would let mature art come back rated `g`.
    wire({
      kind: 'onsite',
      contentRating: 'g',
      coverId: 99,
      recorded: baseline(),
      levels: { [ICON_ID]: NsfwLevel.PG13, 99: NsfwLevel.X, [SHOT_ID]: NsfwLevel.PG },
    });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res.status).toBe('pending');
    expect(flipData()).toEqual({ status: 'pending', contentRating: 'x' });
  });

  it('the floor is RAISE-ONLY on the review arm as well (tame media never lowers `x`)', async () => {
    wire({
      contentRating: 'x',
      iconId: 99,
      recorded: baseline(),
      levels: { 99: NsfwLevel.PG, [COVER_ID]: NsfwLevel.PG, [SHOT_ID]: NsfwLevel.PG },
    });
    await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(flipData()).toEqual({ status: 'pending', contentRating: 'x' });
  });
});

// ---------------------------------------------------------------------------
// The RECORD side.
// ---------------------------------------------------------------------------

describe('unpublishOwnListing — records the approved asset surface', () => {
  it('🔴 writes the live icon/cover/screenshots into `owner-unpublish.before.assets`', async () => {
    const listing = { ...ownedListing({}), status: 'approved' };
    mockWrite.appListing.findUnique.mockReset().mockResolvedValue(listing);
    mockWrite.appListingScreenshot.findMany
      .mockReset()
      .mockResolvedValue([shot(SHOT_ID, 0, 'a demo'), shot(44, 1)]);

    await unpublishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });

    expect(eventData()).toMatchObject({
      action: 'owner-unpublish',
      after: { status: 'removed' },
      before: {
        status: 'approved',
        assets: {
          v: 1,
          iconId: ICON_ID,
          coverId: COVER_ID,
          screenshots: [
            { imageId: SHOT_ID, caption: 'a demo' },
            { imageId: 44, caption: null },
          ],
        },
      },
    });
  });

  it('records an explicit empty surface for a listing with no assets (not a missing one)', async () => {
    const listing = { ...ownedListing({ iconId: null, coverId: null }), status: 'approved' };
    mockWrite.appListing.findUnique.mockReset().mockResolvedValue(listing);
    mockWrite.appListingScreenshot.findMany.mockReset().mockResolvedValue([]);

    await unpublishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });

    expect(eventData().before.assets).toEqual({
      v: 1,
      iconId: null,
      coverId: null,
      screenshots: [],
    });
  });

  it('🔴 record → republish ROUND TRIP: what unpublish wrote lets an untouched republish stay immediate', async () => {
    // The seam neither half tests alone. `unpublishOwnListing` writes the baseline;
    // `republishOwnListing` reads it back and must recognise its own format. A shape
    // change on either side that the other did not follow shows up HERE and nowhere else.
    const shots = [shot(SHOT_ID, 0, 'a demo'), shot(44, 1)];
    const approved = { ...ownedListing({}), status: 'approved' };
    mockWrite.appListing.findUnique.mockReset().mockResolvedValue(approved);
    mockWrite.appListingScreenshot.findMany.mockReset().mockResolvedValue(shots);
    await unpublishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    const recorded = eventData().before.assets;

    vi.clearAllMocks();
    mockWrite.$transaction.mockImplementation(async (cb: (tx: WriteMock) => Promise<unknown>) =>
      cb(mockWrite)
    );
    mockWrite.appListing.updateMany.mockResolvedValue({ count: 1 });
    mockWrite.appListingModerationEvent.create.mockImplementation(
      async (a: { data: unknown }) => a.data
    );
    wire({ shots, recorded });

    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
  });
});

describe('OffsiteModerationError is still the error type callers map', () => {
  it('exports the class the router duck-types on', () => {
    expect(new OffsiteModerationError('NOT_FOUND', 'x').name).toBe('OffsiteModerationError');
  });
});
