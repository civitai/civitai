import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OffsiteRequestError,
  getMyListingForApp,
} from '~/server/services/blocks/offsite-listing.service';

/**
 * `getMyListingForApp` — the owner-gated `appBlockId` → `AppListing.id` resolver
 * for the on-site listing-media owner page. Covers the contract branches:
 *   - owner happy-path → `{ appListingId, status, contentRating, hasPendingRevision,
 *     shadowId, editTargetId, editBlockedReason, assets }`
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
 * check needs, and that they come from the SHADOW revision WHEN ONE EXISTS.
 *
 * 🔴 REGRESSION GUARD — LAZY shadow creation. This proc is a `.query` and must NOT
 * WRITE. It used to call `beginListingRevision`, so merely OPENING the media tab
 * minted a `draft` `AppListing`: measured on prod 2026-07-30, 7 shadows existed and
 * 7/7 had `updated_at == created_at` (never written since their clone tx), 6 minted
 * that day by page views alone, three of them 1.5 s apart. 78% of approved onsite
 * parents carried a shadow representing no edit, and deleting them just refilled on
 * the next view. The shadow is now minted by the first asset MUTATION.
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
    screenshots: [
      { id: ssRowId, imageId: 30, order: 0, caption: null, image: { url: 'shot-key' } },
    ],
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

/**
 * Wire the SHADOW-existence probe. It reads the PRIMARY (`dbWrite`) on purpose: the
 * client invalidates this query after every asset mutation, and the FIRST mutation is
 * what mints the shadow — so the very next call is a read-after-write on a row
 * inserted milliseconds ago, and missing it on a lagging replica would re-project the
 * PARENT's rows (and their screenshot row ids) just as the shadow started diverging.
 */
function withShadow(shadowId: string | null) {
  mockWrite.appListing.findFirst.mockImplementation(async (args: unknown) => {
    const a = args as { where?: { revisionOfId?: string } };
    if (a.where?.revisionOfId != null) return shadowId ? { id: shadowId } : null;
    return null;
  });
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
    // An in-flight shadow already exists → it is reused (never a second one).
    withShadow('apl_shadow');

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(res).toMatchObject({
      appListingId: 'apl_onsite',
      status: 'approved',
      contentRating: 'pg13',
      hasPendingRevision: false,
      shadowId: 'apl_shadow',
      editTargetId: 'apl_shadow',
      editBlockedReason: null,
    });
    // Reuse, not re-create: the UNIQUE index on revision_of_id (one shadow per parent)
    // is never even challenged.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
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
    withShadow('apl_shadow');
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
    withShadow('apl_shadow');

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
    withShadow('apl_shadow');

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

  // -------------------------------------------------------------------------
  // 🔴 LAZY CREATION — the read must NOT mint a shadow. This is a `.query`.
  // -------------------------------------------------------------------------

  it('🔴 NO shadow yet → projects the PARENT’s assets and creates NOTHING', async () => {
    wireFindUnique({
      entry: {
        id: 'apl_onsite',
        userId: OWNER,
        status: 'approved',
        contentRating: 'pg13',
        revisionOfId: null,
      },
      owned: ownedRow(),
      viewByListingId: { apl_onsite: editViewRow('apls_PARENT') },
    });
    withShadow(null);

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    // 🔴 THE GUARD: opening the media tab writes NOTHING. On prod this write-in-a-query
    // produced 7 shadows, 7/7 never edited (updated_at == created_at), 6 minted in one
    // day by page views alone — and they refilled the instant anyone looked again.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
    expect(mockWrite.appListingScreenshot.createMany).not.toHaveBeenCalled();
    expect(res.shadowId).toBeNull();
    // …and the editor still sees real assets to edit + a target to mutate: the PARENT.
    // Safe only because the WRITE side re-keys any parent screenshot row id onto the
    // shadow it mints (see the app-listing-assets lazy-mint suite).
    expect(res.editTargetId).toBe('apl_onsite');
    expect(res.editBlockedReason).toBeNull();
    expect(res.assets.icon.imageId).toBe(137918008);
    expect(res.assets.screenshots.map((s) => s.id)).toEqual(['apls_PARENT']);
    // No shadow ⇒ no read-after-write ⇒ the edit-view read stays on the replica.
    expect(editViewReads(mockRead)).toEqual(['apl_onsite']);
    expect(editViewReads(mockWrite)).toEqual([]);
  });

  it('🔴 the shadow-existence probe reads the PRIMARY (read-after-write on the first edit)', async () => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OWNER, status: 'approved', contentRating: 'pg13' },
      owned: ownedRow(),
      viewByListingId: {
        apl_onsite: editViewRow('apls_PARENT'),
        apl_shadow: editViewRow('apls_SHADOW'),
      },
      // The shadow was INSERTed on the primary microseconds ago (the owner's first
      // asset mutation) — the replica has not caught up.
      replicaLagsOn: ['apl_shadow'],
    });
    // The replica does NOT see the shadow; the primary does.
    mockRead.appListing.findFirst.mockResolvedValue(null);
    withShadow('apl_shadow');

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    // Probing the REPLICA here would report "no shadow" and hand the client the LIVE
    // parent's rows right after the shadow started diverging — the client invalidates
    // this query after every mutation, so that is the common case, not a rare one.
    expect(res.shadowId).toBe('apl_shadow');
    expect(res.editTargetId).toBe('apl_shadow');
    expect(res.assets.screenshots.map((s) => s.id)).toEqual(['apls_SHADOW']);
    expect(mockWrite.appListing.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { revisionOfId: 'apl_onsite' } })
    );
  });

  it('a NON-approved listing has no shadow — assets come from the listing itself', async () => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OWNER, status: 'draft', contentRating: 'g' },
      owned: ownedRow({ status: 'draft' }),
      viewByListingId: { apl_onsite: editViewRow('apls_OWN') },
    });

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(res.shadowId).toBeNull();
    // No shadow is ever opened for a draft — it is edited IN PLACE, unchanged.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
    expect(res.editTargetId).toBe('apl_onsite');
    expect(res.editBlockedReason).toBeNull();
    expect(res.assets.screenshots.map((s) => s.id)).toEqual(['apls_OWN']);
    // Nothing was written, so nothing needs the primary.
    expect(editViewReads(mockRead)).toEqual(['apl_onsite']);
    expect(editViewReads(mockWrite)).toEqual([]);
    // A draft has no shadow to probe for at all.
    expect(mockWrite.appListing.findFirst).not.toHaveBeenCalled();
  });

  it('a PENDING listing is likewise edited in place (unchanged)', async () => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OWNER, status: 'pending', contentRating: 'g' },
      viewByListingId: { apl_onsite: editViewRow('apls_OWN') },
    });

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(res).toMatchObject({
      status: 'pending',
      shadowId: null,
      editTargetId: 'apl_onsite',
      editBlockedReason: null,
    });
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 🔴 The editability VERDICT. The client used to learn "this listing can't be
  // revised" from the on-mount `beginListingRevision`'s INVALID_REVISION, which is
  // the only thing that kept the media editor from mounting against a removed /
  // rejected listing. Lazy creation removes that call, so the verdict must arrive on
  // the READ — otherwise the owner gets a fully-functional editor over a dead
  // listing (or a blank page).
  // -------------------------------------------------------------------------

  it.each([
    ['removed', 'this listing has been removed by a moderator and can no longer be edited'],
    ['rejected', 'this listing was rejected; submit a new listing instead of editing it'],
  ])('🔴 a %s listing returns an inline editBlockedReason, not a blank page', async (
    status,
    expected
  ) => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OWNER, status, contentRating: 'g', revisionOfId: null },
      viewByListingId: { apl_onsite: editViewRow('apls_OWN') },
    });

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(res.editBlockedReason).toBe(expected);
    expect(res.status).toBe(status);
    // It is a VERDICT, not a throw — the page still renders (alert + no editor), which
    // is what the "don't collapse to NotFound" narrowing exists to preserve.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('🔴 an internal SHADOW resolved directly is not an editable page', async () => {
    wireFindUnique({
      entry: {
        id: 'apl_shadow',
        userId: OWNER,
        status: 'draft',
        contentRating: 'g',
        revisionOfId: 'apl_onsite',
      },
      viewByListingId: { apl_shadow: editViewRow('apls_SHADOW') },
    });

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(res.editBlockedReason).toBe(
      'this listing is an internal revision draft and cannot be edited directly'
    );
  });

  // -------------------------------------------------------------------------
  // 🔴 READ-AFTER-WRITE: a SHADOW is INSERTed on the PRIMARY (by the owner's first
  // asset mutation), so ANY read of one goes back to the primary — the predicate is
  // "the target is a shadow", not "this call created it". Reading a shadow off the
  // replica misses under lag → `loadListingEditView` throws NOT_FOUND → tRPC
  // NOT_FOUND → the editor's query is `retry: false` and it renders <NotFound/>,
  // discarding the editor and any in-flight upload. The client invalidates on every
  // asset mutation, so the exposure is per-mutation.
  // -------------------------------------------------------------------------

  it('🔴 a shadow ALWAYS reads from the PRIMARY, never the replica', async () => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OWNER, status: 'approved', contentRating: 'pg13' },
      owned: ownedRow(),
      viewByListingId: { apl_shadow: editViewRow('apls_shadow') },
    });
    withShadow('apl_shadow');

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(res.shadowId).toBe('apl_shadow');
    // Only shadow reads move to the primary; the in-place draft/pending read (and an
    // approved parent with no shadow yet) stays on the replica.
    expect(editViewReads(mockWrite)).toEqual(['apl_shadow']);
    expect(editViewReads(mockRead)).toEqual([]);
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
    // A draft is NOT approved → no shadow revision; it is its own EFFECTIVE edit target,
    // so the edit-view assets are read straight off `apl_draft` (#3476 projection).
    wireFindUnique({ entry: null, viewByListingId: { apl_draft: editViewRow('apls_draft') } });

    const res = await getMyListingForApp({ slug: 'my-app', userId: OWNER });

    expect(res).toMatchObject({
      appListingId: 'apl_draft',
      status: 'draft',
      contentRating: 'g',
      hasPendingRevision: false,
      // Edited in place while pending — no shadow is minted for a draft.
      shadowId: null,
    });
    // The media editor can SEE the icon/cover it is about to edit on a pending draft.
    expect(res.assets.icon).not.toBeNull();
    expect(res.assets.cover).not.toBeNull();
    // The only findUnique is the edit-view read — never the appBlockId entry resolve.
    expect(editViewReads(mockRead)).toEqual(['apl_draft']);
    expect(
      mockRead.appListing.findUnique.mock.calls.some(
        ([a]) => (a as { where?: { appBlockId?: string } })?.where?.appBlockId != null
      )
    ).toBe(false);
    // Scoped to the EXACT pre-approval-draft shape (onsite / null appBlockId / draft).
    expect(mockRead.appListing.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'my-app', kind: 'onsite', appBlockId: null, status: 'draft' },
      })
    );
  });

  it('falls back to the slug draft when the appBlockId lookup misses', async () => {
    // Entry resolve by appBlockId MISSES (no approved listing yet) → slug fallback wins.
    wireFindUnique({ entry: null, viewByListingId: { apl_draft: editViewRow('apls_draft') } });
    mockRead.appListing.findFirst.mockResolvedValue({
      id: 'apl_draft',
      userId: OWNER,
      status: 'draft',
      contentRating: 'pg',
    });

    const res = await getMyListingForApp({ appBlockId: 'maybe', slug: 'my-app', userId: OWNER });

    expect(res.appListingId).toBe('apl_draft');
    expect(mockRead.appListing.findFirst).toHaveBeenCalledOnce();
    expect(editViewReads(mockRead)).toEqual(['apl_draft']);
  });

  it('a draft owned by ANOTHER user → NOT_OWNED (ownership still enforced on the slug path)', async () => {
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
