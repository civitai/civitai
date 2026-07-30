import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OffsiteRequestError,
  getMyListingForApp,
} from '~/server/services/blocks/offsite-listing.service';

/**
 * `getMyListingForApp` — the owner-gated `appBlockId` → `AppListing.id` resolver
 * for the on-site listing-media owner page. Covers the contract branches:
 *   - owner happy-path → `{ appListingId, status, contentRating, hasPendingRevision,
 *     shadowId, assets }`
 *   - a listing owned by ANOTHER user → NOT_OWNED (router maps → FORBIDDEN)
 *   - no listing row for the app → NOT_FOUND
 * plus the pending-revision flag (a queued shadow-revision request flips it true).
 *
 * 🔴 REGRESSION GUARD — the media editor's asset PROJECTION. The proc used to
 * return only `{ id, userId, status, contentRating }`, so the editor had no way to
 * see the icon/cover it was about to edit: every slot rendered "none", its publish
 * floor (icon+cover attached) could never be met, and "Submit for review" was
 * permanently disabled — the on-site listing-media flow was uncompletable for
 * everyone. The tests below pin that the proc projects the assets the editor's floor
 * check needs, and that they come from the SHADOW revision (the editable target),
 * never the live parent — returning the parent's `AppListingScreenshot` row ids
 * would let a "remove screenshot" delete a row off the LIVE listing, bypassing
 * moderator review.
 *
 * DB is fully mocked — no real Prisma. `getEdgeUrl` + the id generators are stubbed.
 */

const { mockRead, mockWrite, seq } = vi.hoisted(() => {
  const makeClient = () => ({
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (args: { data: unknown }) => args.data),
      update: vi.fn(async (args: { data: unknown }) => args.data),
    },
    appListingScreenshot: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      createMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
    appListingPublishRequest: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
  });
  const mockRead = makeClient();
  const mockWrite = makeClient() as ReturnType<typeof makeClient> & {
    $transaction: ReturnType<typeof vi.fn>;
  };
  mockWrite.$transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
  return { mockRead, mockWrite, seq: { n: 0 } };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (url: string) => `edge:${url}` }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_new_${++seq.n}`,
  newAppListingPublishRequestId: () => `alpr_new_${++seq.n}`,
  newAppListingScreenshotId: () => `apls_new_${++seq.n}`,
  newUlid: () => `ULID${++seq.n}`,
}));

const OWNER = 42;
const OTHER = 99;

/** The `editableListingSelect` shape `beginListingRevision` loads the parent with. */
function ownedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'apl_onsite',
    kind: 'onsite',
    slug: 'my-app',
    status: 'approved',
    userId: OWNER,
    revisionOfId: null,
    name: 'My App',
    tagline: null,
    description: null,
    category: null,
    contentRating: 'pg13',
    externalUrl: null,
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    iconId: 137918008,
    coverId: 137918011,
    ...overrides,
  };
}

/** The `loadListingEditView` shape. `ssRowId` marks WHOSE screenshot rows these are. */
function editViewRow(ssRowId: string, overrides: Record<string, unknown> = {}) {
  return {
    name: 'My App',
    tagline: null,
    description: null,
    category: null,
    contentRating: 'pg13',
    externalUrl: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    iconId: 137918008,
    coverId: 137918011,
    icon: { url: 'icon-key' },
    cover: { url: 'cover-key' },
    screenshots: [{ id: ssRowId, imageId: 30, order: 0, caption: null, image: { url: 'shot-key' } }],
    ...overrides,
  };
}

/**
 * Route `appListing.findUnique` by call shape, on BOTH pools:
 *   - `where.appBlockId`   → the entry resolve (id/userId/status/contentRating)
 *   - `select` has `icon`  → `loadListingEditView`, keyed by `where.id`
 *   - otherwise            → the owner/editable load (`beginListingRevision`)
 *
 * `replicaLagsOn` makes the REPLICA miss on the given ids while the PRIMARY still
 * serves them — i.e. real replication lag, the condition that decides whether a
 * shadow read is routed correctly (on BOTH the create and the reuse path).
 */
function wireFindUnique(opts: {
  entry: unknown;
  owned?: unknown;
  viewByListingId?: Record<string, unknown>;
  /** Ids the replica has not received yet (a row INSERTed microseconds ago). */
  replicaLagsOn?: string[];
}) {
  const impl = (isReplica: boolean) => async (args: unknown) => {
    const a = args as {
      select?: Record<string, unknown>;
      where?: { id?: string; appBlockId?: string };
    };
    if (a.where?.appBlockId != null) return opts.entry;
    if ('icon' in (a.select ?? {})) {
      const id = a.where?.id ?? '';
      if (isReplica && (opts.replicaLagsOn ?? []).includes(id)) return null;
      return opts.viewByListingId?.[id] ?? null;
    }
    return opts.owned ?? null;
  };
  mockRead.appListing.findUnique.mockImplementation(impl(true));
  mockWrite.appListing.findUnique.mockImplementation(impl(false));
}

/** The listing ids whose `loadListingEditView` read landed on a given pool. */
function editViewReads(client: { appListing: { findUnique: { mock: { calls: unknown[][] } } } }) {
  return client.appListing.findUnique.mock.calls
    .map(([a]) => a as { select?: Record<string, unknown>; where?: { id?: string } })
    .filter((a) => 'icon' in (a?.select ?? {}))
    .map((a) => a.where?.id ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  seq.n = 0;
  mockRead.appListing.findUnique.mockResolvedValue(null);
  // (W13 draft-at-submit) the pre-approval DRAFT by-slug fallback reads through findFirst.
  mockRead.appListing.findFirst.mockResolvedValue(null);
  mockRead.appListingScreenshot.findMany.mockResolvedValue([]);
  mockRead.appListingPublishRequest.findFirst.mockResolvedValue(null);
  mockWrite.appListing.findFirst.mockResolvedValue(null);
  mockWrite.appListingScreenshot.findMany.mockResolvedValue([]);
});

describe('getMyListingForApp', () => {
  it('owner happy-path → returns the listing id + status + rating (no pending revision)', async () => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OWNER, status: 'approved', contentRating: 'pg13' },
      owned: ownedRow(),
      viewByListingId: { apl_shadow: editViewRow('apls_shadow') },
    });
    // An in-flight shadow already exists → beginListingRevision reuses it.
    mockRead.appListing.findFirst.mockResolvedValue({ id: 'apl_shadow' });

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(res).toMatchObject({
      appListingId: 'apl_onsite',
      status: 'approved',
      contentRating: 'pg13',
      hasPendingRevision: false,
      shadowId: 'apl_shadow',
    });
    // Resolved by the @unique appBlockId, not by id.
    expect(mockRead.appListing.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { appBlockId: 'my-block' } })
    );
  });

  it('flags hasPendingRevision when a shadow-revision request is already queued', async () => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OWNER, status: 'approved', contentRating: 'g' },
      owned: ownedRow({ contentRating: 'g' }),
      viewByListingId: { apl_shadow: editViewRow('apls_shadow') },
    });
    mockRead.appListing.findFirst.mockResolvedValue({ id: 'apl_shadow' });
    mockRead.appListingPublishRequest.findFirst.mockResolvedValue({ id: 'alpr_pending' });

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(res.hasPendingRevision).toBe(true);
    // The pending check is scoped to a pending request whose listing is a shadow of ours.
    expect(mockRead.appListingPublishRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'pending',
          appListing: { revisionOfId: 'apl_onsite' },
        }),
      })
    );
  });

  it('a listing owned by another user → NOT_OWNED', async () => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OTHER, status: 'approved', contentRating: 'g' },
    });

    await expect(
      getMyListingForApp({ appBlockId: 'my-block', userId: OWNER })
    ).rejects.toMatchObject({ name: 'OffsiteRequestError', code: 'NOT_OWNED' });
    // Never probes the revision request once ownership fails.
    expect(mockRead.appListingPublishRequest.findFirst).not.toHaveBeenCalled();
  });

  it('no listing row for the app → NOT_FOUND', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(null);

    const err = await getMyListingForApp({ appBlockId: 'ghost', userId: OWNER }).catch((e) => e);
    expect(err).toBeInstanceOf(OffsiteRequestError);
    expect(err.code).toBe('NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // 🔴 The asset projection — what makes the media editor's Submit button usable.
  // -------------------------------------------------------------------------

  it('projects the editable target’s icon/cover/screenshots so the editor’s publish floor can be met', async () => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OWNER, status: 'approved', contentRating: 'pg13' },
      owned: ownedRow(),
      viewByListingId: { apl_shadow: editViewRow('apls_shadow') },
    });
    mockRead.appListing.findFirst.mockResolvedValue({ id: 'apl_shadow' });

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    // The editor seeds an icon/cover slot as ATTACHED iff `imageId != null`, and its
    // floor is `icon.attached && cover.attached`. A result without these fields is
    // exactly the "Icon none / Cover none → Submit permanently disabled" bug.
    expect(res.assets.icon.imageId).toBe(137918008);
    expect(res.assets.cover.imageId).toBe(137918011);
    const meetsPublishFloor = res.assets.icon.imageId != null && res.assets.cover.imageId != null;
    expect(meetsPublishFloor).toBe(true);
    // Edge-resolved preview URLs (so the attached slots render a thumbnail).
    expect(res.assets.icon.url).toBe('edge:icon-key');
    expect(res.assets.cover.url).toBe('edge:cover-key');
    expect(res.assets.screenshots).toHaveLength(1);
    expect(res.assets.screenshots[0]).toMatchObject({ imageId: 30, url: 'edge:shot-key' });
  });

  it('🔴 reads the assets from the SHADOW revision, never the live parent (reused shadow)', async () => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OWNER, status: 'approved', contentRating: 'pg13' },
      owned: ownedRow(),
      viewByListingId: {
        // Distinct rows per listing id so we can tell WHICH one was read.
        apl_onsite: editViewRow('apls_PARENT', { iconId: 1, icon: { url: 'parent-icon' } }),
        apl_shadow: editViewRow('apls_SHADOW', { iconId: 2, icon: { url: 'shadow-icon' } }),
      },
    });
    mockRead.appListing.findFirst.mockResolvedValue({ id: 'apl_shadow' });

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(res.shadowId).toBe('apl_shadow');
    expect(res.assets.icon.imageId).toBe(2);
    expect(res.assets.icon.url).toBe('edge:shadow-icon');
    // The screenshot ROW ids are the shadow's — removing one must never touch the
    // live listing's rows.
    expect(res.assets.screenshots.map((s) => s.id)).toEqual(['apls_SHADOW']);
    // And the edit-view read targeted the shadow, not the parent (on the primary —
    // a shadow is always read there; see the read-after-write block below).
    expect(mockWrite.appListing.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'apl_shadow' },
        select: expect.objectContaining({ icon: expect.anything() }),
      })
    );
    expect(editViewReads(mockRead)).toEqual([]);
  });

  it('🔴 creates the shadow when none exists yet and reads THAT one (first entry)', async () => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OWNER, status: 'approved', contentRating: 'pg13' },
      owned: ownedRow(),
      viewByListingId: {
        apl_onsite: editViewRow('apls_PARENT'),
        // beginListingRevision mints `apl_new_1` (stubbed id gen, first call).
        apl_new_1: editViewRow('apls_FRESH_SHADOW'),
      },
    });
    // No shadow yet: the read probe and the in-transaction race re-check both miss,
    // then the post-transaction "winner" re-read returns the row we just created.
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'apl_new_1' });

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(mockWrite.appListing.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revisionOfId: 'apl_onsite', status: 'draft' }),
      })
    );
    expect(res.shadowId).toBe('apl_new_1');
    expect(res.assets.screenshots.map((s) => s.id)).toEqual(['apls_FRESH_SHADOW']);
  });

  it('a NON-approved listing has no shadow — assets come from the listing itself', async () => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OWNER, status: 'draft', contentRating: 'g' },
      owned: ownedRow({ status: 'draft' }),
      viewByListingId: { apl_onsite: editViewRow('apls_OWN') },
    });

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(res.shadowId).toBeNull();
    // No shadow was opened for a draft (beginListingRevision would reject it anyway).
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
    expect(res.assets.screenshots.map((s) => s.id)).toEqual(['apls_OWN']);
    // Nothing was written, so nothing needs the primary.
    expect(editViewReads(mockRead)).toEqual(['apl_onsite']);
    expect(editViewReads(mockWrite)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 🔴 READ-AFTER-WRITE: a SHADOW is INSERTed on the PRIMARY, so ANY read of one
  // goes back to the primary — the predicate is "the target is a shadow", NOT
  // "this call created it". `created: false` says only that another caller minted
  // it, which here is routinely microseconds ago and in a different request (the
  // editor's own client-side `beginListingRevision`, `getMyListingForEdit`, a second
  // tab). Reading a shadow off the replica misses under lag → `loadListingEditView`
  // throws NOT_FOUND → tRPC NOT_FOUND → the editor's query is `retry: false` and it
  // renders <NotFound/>, discarding the editor and any in-flight upload. The client
  // invalidates on every asset mutation, so the exposure is per-mutation.
  // -------------------------------------------------------------------------

  it('🔴 reads a FRESHLY-CREATED shadow from the PRIMARY, not the lagging replica', async () => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OWNER, status: 'approved', contentRating: 'pg13' },
      owned: ownedRow(),
      viewByListingId: {
        apl_onsite: editViewRow('apls_PARENT'),
        apl_new_1: editViewRow('apls_FRESH_SHADOW'),
      },
      // The shadow was INSERTed on the primary this instant — the replica misses it.
      replicaLagsOn: ['apl_new_1'],
    });
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'apl_new_1' });

    // Routed to the replica this REJECTS with NOT_FOUND instead of resolving.
    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(res.shadowId).toBe('apl_new_1');
    expect(res.assets.screenshots.map((s) => s.id)).toEqual(['apls_FRESH_SHADOW']);
    // …and it got there by reading the PRIMARY, never the replica.
    expect(editViewReads(mockWrite)).toEqual(['apl_new_1']);
    expect(editViewReads(mockRead)).toEqual([]);
  });

  it('🔴 a REUSED (pre-existing) shadow ALSO reads from the PRIMARY — `created` is not a visibility claim', async () => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OWNER, status: 'approved', contentRating: 'pg13' },
      owned: ownedRow(),
      viewByListingId: { apl_shadow: editViewRow('apls_shadow') },
    });
    // An in-flight shadow already exists → `beginListingRevision` returns created:false.
    mockRead.appListing.findFirst.mockResolvedValue({ id: 'apl_shadow' });

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(res.shadowId).toBe('apl_shadow');
    // The routing predicate is "the target is a SHADOW", not "I inserted it". `created:
    // false` only says another caller minted it — which in this flow is routinely
    // microseconds ago and in a different request (the editor's own client-side
    // `beginListingRevision`, `getMyListingForEdit`, a second tab). Only shadow reads
    // move to the primary; the in-place draft/pending read below stays on the replica.
    expect(editViewReads(mockWrite)).toEqual(['apl_shadow']);
    expect(editViewReads(mockRead)).toEqual([]);
  });

  it('🔴 a REUSED shadow the replica has NOT caught up on still returns its assets (no NOT_FOUND)', async () => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OWNER, status: 'approved', contentRating: 'pg13' },
      owned: ownedRow(),
      viewByListingId: {
        apl_onsite: editViewRow('apls_PARENT'),
        apl_shadow: editViewRow('apls_SHADOW'),
      },
      // The shadow exists on the PRIMARY (a concurrent request minted it microseconds
      // ago) but has not replicated yet. `beginListingRevision` reports created:FALSE.
      replicaLagsOn: ['apl_shadow'],
    });
    // The idempotency probe reads the replica, misses, and the in-tx re-check on the
    // primary finds the concurrent winner → returns { created: false }.
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst.mockResolvedValue({ id: 'apl_shadow' });

    // Routed by `created` this reads the lagging replica → NOT_FOUND → the editor
    // renders <NotFound /> (retry:false) and the in-flight upload is discarded.
    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(res.shadowId).toBe('apl_shadow');
    expect(res.assets.screenshots.map((s) => s.id)).toEqual(['apls_SHADOW']);
    expect(editViewReads(mockWrite)).toEqual(['apl_shadow']);
    expect(editViewReads(mockRead)).toEqual([]);
    // And it never fell back to the live parent's rows.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });
});

// W13 draft-at-submit — a FIRST-version app has no AppBlock yet, so the owner-media
// page reaches its pre-approval draft BY SLUG (`appBlockId IS NULL`). These lock the
// slug fallback: the owner reaches their pending draft; ownership is still enforced.
describe('getMyListingForApp — pre-approval DRAFT slug resolver (pending, no AppBlock)', () => {
  it('resolves the pending draft BY SLUG when only a slug is given (no appBlockId lookup)', async () => {
    mockRead.appListing.findFirst.mockResolvedValue({
      id: 'apl_draft',
      userId: OWNER,
      status: 'draft',
      contentRating: 'g',
    });

    const res = await getMyListingForApp({ slug: 'my-app', userId: OWNER });

    expect(res).toEqual({
      appListingId: 'apl_draft',
      status: 'draft',
      contentRating: 'g',
      hasPendingRevision: false,
    });
    // Never touches the appBlockId path when no appBlockId is supplied.
    expect(mockRead.appListing.findUnique).not.toHaveBeenCalled();
    // Scoped to the EXACT pre-approval-draft shape (onsite / null appBlockId / draft).
    expect(mockRead.appListing.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'my-app', kind: 'onsite', appBlockId: null, status: 'draft' },
      })
    );
  });

  it('falls back to the slug draft when the appBlockId lookup misses', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(null); // no approved listing yet
    mockRead.appListing.findFirst.mockResolvedValue({
      id: 'apl_draft',
      userId: OWNER,
      status: 'draft',
      contentRating: 'pg',
    });

    const res = await getMyListingForApp({ appBlockId: 'maybe', slug: 'my-app', userId: OWNER });

    expect(res.appListingId).toBe('apl_draft');
    expect(mockRead.appListing.findUnique).toHaveBeenCalledOnce();
    expect(mockRead.appListing.findFirst).toHaveBeenCalledOnce();
  });

  it("a draft owned by ANOTHER user → NOT_OWNED (ownership still enforced on the slug path)", async () => {
    mockRead.appListing.findFirst.mockResolvedValue({
      id: 'apl_draft',
      userId: OTHER,
      status: 'draft',
      contentRating: 'g',
    });

    await expect(getMyListingForApp({ slug: 'my-app', userId: OWNER })).rejects.toMatchObject({
      name: 'OffsiteRequestError',
      code: 'NOT_OWNED',
    });
    expect(mockRead.appListingPublishRequest.findFirst).not.toHaveBeenCalled();
  });

  it('no draft for the slug → NOT_FOUND', async () => {
    mockRead.appListing.findFirst.mockResolvedValue(null);

    const err = await getMyListingForApp({ slug: 'ghost', userId: OWNER }).catch((e) => e);
    expect(err).toBeInstanceOf(OffsiteRequestError);
    expect(err.code).toBe('NOT_FOUND');
  });
});
