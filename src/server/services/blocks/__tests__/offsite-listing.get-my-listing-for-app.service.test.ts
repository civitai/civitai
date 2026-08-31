import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OffsiteRequestError,
  getMyListingForApp,
} from '~/server/services/blocks/offsite-listing.service';

/**
 * `getMyListingForApp` — the owner-gated `appBlockId`-or-`slug` → `AppListing.id`
 * resolver every listing-media surface is hosted on. Covers the contract branches:
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
    // 🔴 SEATS ARE LISTING-KEYED, so every non-owner path consults this table — and since
    // the owner half of the gate is resolved too (never compared against the
    // denormalized AppListing.userId), the resolver is on EVERY path. Default: no seat,
    // i.e. exactly the owner-only behaviour these cases assert.
    appCollaborator: { findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    // The last-moderation-event lookup that separates an OWNER self-unpublish from a
    // MODERATOR takedown on a `removed` listing (both write `status='removed'`). Default
    // NO event ⇒ not owner-unpublish ⇒ still refused, which is what the `removed` cases
    // below assert. Owner-unpublish is covered in
    // `offsite-listing.owner-unpublish-editable.service.test.ts`.
    appListingModerationEvent: {
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
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => `edge:${url}` }));
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
 *   - otherwise            → the owner/editable load (`beginListingRevision`), AND the
 *     ownership resolve. The gate no longer compares the caller against the entry row's
 *     denormalized `userId`; it re-reads the listing BY ID through `resolveListingAccess`
 *     so the canonical (`appBlock.app.userId`) owner decides. `owned` therefore defaults
 *     to `entry`: a case that does not care about the editable load still has to serve
 *     the ownership read, and serving the same row is what "these are the same listing"
 *     means here.
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
    return opts.owned ?? opts.entry ?? null;
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
  mockRead.appCollaborator.findFirst.mockResolvedValue(null);
  mockWrite.appCollaborator.findFirst.mockResolvedValue(null);
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

  /**
   * 🔴 THE SEAM: the proc RESOLVES a role, and `ListingMediaEditor` BRANCHES on it.
   *
   * Nothing bound those two together, which is exactly the shape that stays broken while
   * both sides look tested. `listing-media-page.browser.test.tsx` STUBS this query, so it
   * asserts what the component does with a `role` it was handed — it cannot notice the
   * server no longer sending one. And the cases above assert this proc's other fields
   * without ever mentioning `role`. Drop `role` from the return and every one of those
   * tests still passes, while `listing?.role === 'owner'` silently becomes `false` for
   * OWNERS and every owner reads the collaborator copy.
   *
   * So this asserts the PRODUCED value, per role, on the same fixture — the half the
   * component tests structurally cannot cover.
   */
  it('🔴 returns the OWNER role — the media editor branches its copy on this', async () => {
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OWNER, status: 'approved', contentRating: 'pg13' },
      owned: ownedRow(),
      viewByListingId: { apl_shadow: editViewRow('apls_shadow') },
    });
    withShadow('apl_shadow');

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });
    expect(res.role).toBe('owner');
  });

  it('🔴 returns the EDITOR role for an ACCEPTED SEAT — this proc is not owner-only', async () => {
    // 🔴 The listing is owned by someone ELSE and the call still succeeds, which is the
    // whole point: the gate is `resolveListingRole(...) === null`, not an ownership
    // comparison. Reading it as owner-only is what produced copy telling a seated editor
    // "you unpublished it" and pointing them at an owner-only Publishing tab.
    wireFindUnique({
      entry: { id: 'apl_onsite', userId: OTHER, status: 'approved', contentRating: 'pg13' },
      // 🔴 `userId: OTHER` on the OWNED row too, not just the entry — `resolveListingAccess`
      // reads THIS row to decide ownership. Leaving it as the default OWNER makes the caller
      // the owner and the seat is never consulted, so the case would assert 'editor' against
      // a fixture that can only ever produce 'owner'.
      owned: ownedRow({ userId: OTHER, appBlock: { app: { userId: OTHER } } }),
      viewByListingId: { apl_shadow: editViewRow('apls_shadow') },
    });
    withShadow('apl_shadow');
    // An ACCEPTED seat on the LISTING for the caller.
    mockRead.appCollaborator.findFirst.mockResolvedValue({
      id: 'acol_1',
      appListingId: 'apl_onsite',
      userId: OWNER,
      status: 'accepted',
      role: 'editor',
    });

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });
    expect(res.role).toBe('editor');
    // The discriminating control: the two roles must actually DIFFER on this proc, or a
    // mutant that hardcodes `'owner'` passes the case above and this one is the only thing
    // that can see it.
    expect(res.role).not.toBe('owner');
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
  ])(
    '🔴 a %s listing returns an inline editBlockedReason, not a blank page',
    async (status, expected) => {
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
    }
  );

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

/**
 * A `where`-HONOURING stand-in for the slug fallback's `dbRead.appListing.findFirst`.
 *
 * 🔴 EVERY CASE BELOW IS A CLAIM ABOUT WHICH ROWS THE `where` CLAUSE ADMITS, so a mock
 * that hands back a fixed row whatever the clause said would pass under ANY clause —
 * including the narrow one this resolver used to carry. This evaluates the clause the
 * service actually sent against a row set: an off-site row is admitted only because the
 * service stopped asking for `kind: 'onsite'`, and a shadow is rejected only because it
 * asks for `revisionOfId: null`.
 */
function wireSlugLookup(rows: Array<Record<string, unknown>>) {
  mockRead.appListing.findFirst.mockImplementation(async (args: unknown) => {
    const where = (args as { where?: Record<string, unknown> }).where ?? {};
    const matches = (row: Record<string, unknown>) =>
      Object.entries(where).every(([field, expected]) => {
        // `{ not: … }` is the only Prisma filter object this clause has ever used
        // (it is the narrowing offered in the issue thread), so support just that.
        if (expected !== null && typeof expected === 'object' && 'not' in expected) {
          return row[field] !== (expected as { not: unknown }).not;
        }
        return row[field] === expected;
      });
    return rows.find(matches) ?? null;
  });
}

// The SLUG resolver. Two callers share it: the W13 pre-approval draft of a FIRST-version
// on-site app (no AppBlock yet, so `appBlockId` cannot address it *yet*), and an OFF-SITE
// listing, which in practice carries no AppBlock at all — civitai/civitai#3984. These
// lock what the slug arm admits (any top-level listing, either kind, any status) and what
// it refuses (a shadow revision), that `appBlockId` takes PRECEDENCE over the slug, and
// that ownership is still enforced on the widened path.
describe('getMyListingForApp — slug resolver (any top-level listing, either kind)', () => {
  it('resolves the pending draft BY SLUG when only a slug is given (no appBlockId lookup)', async () => {
    // 🔴 The pre-approval draft carries `appBlockId: null`, so it has no OauthClient in
    // its ownership chain and `AppListing.userId` IS its canonical owner — the resolver's
    // fallback. The row is served on `findUnique` too because the gate resolves the
    // listing BY ID rather than trusting the row the slug lookup handed it.
    const draft = {
      id: 'apl_draft',
      userId: OWNER,
      kind: 'onsite',
      slug: 'my-app',
      appBlockId: null,
      revisionOfId: null,
      status: 'draft',
      contentRating: 'g',
    };
    // Predicate-honouring, so this also pins that the WIDENED clause is a SUPERSET —
    // the pre-approval draft is still admitted by it.
    wireSlugLookup([draft]);
    // A draft is NOT approved → no shadow revision; it is its own EFFECTIVE edit target,
    // so the edit-view assets are read straight off `apl_draft` (#3476 projection).
    wireFindUnique({
      entry: null,
      owned: draft,
      viewByListingId: { apl_draft: editViewRow('apls_draft') },
    });

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
    // Scoped to a TOP-LEVEL listing by its globally-unique slug — no kind, appBlockId
    // or status narrowing (civitai/civitai#3984). `revisionOfId: null` is the one
    // remaining clause and it is load-bearing; see the shadow case below.
    expect(mockRead.appListing.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'my-app', revisionOfId: null } })
    );
  });

  it('falls back to the slug draft when the appBlockId lookup misses', async () => {
    const draft = {
      id: 'apl_draft',
      userId: OWNER,
      kind: 'onsite',
      appBlockId: null,
      revisionOfId: null,
      status: 'draft',
      contentRating: 'pg',
    };
    // Entry resolve by appBlockId MISSES (no approved listing yet) → slug fallback wins.
    wireFindUnique({
      entry: null,
      owned: draft,
      viewByListingId: { apl_draft: editViewRow('apls_draft') },
    });
    mockRead.appListing.findFirst.mockResolvedValue(draft);

    const res = await getMyListingForApp({ appBlockId: 'maybe', slug: 'my-app', userId: OWNER });

    expect(res.appListingId).toBe('apl_draft');
    expect(mockRead.appListing.findFirst).toHaveBeenCalledOnce();
    expect(editViewReads(mockRead)).toEqual(['apl_draft']);
  });

  /**
   * 🔴 SELECTOR PRECEDENCE — the OTHER half of `if (!listing && slug)`, and the half
   * nothing pinned. The test above proves the slug arm RUNS on a miss; this one proves it
   * does NOT run on a hit. Both selectors are optional and independent, so a caller can
   * hand over an `appBlockId` and a slug that name DIFFERENT listings, and which one wins
   * is a contract, not an implementation detail.
   *
   * Measured before this test existed: mutating `if (!listing && slug)` → `if (slug)`
   * SURVIVED the whole 44-test battery. The slug row simply overwrote the block row and
   * every assertion still held, because no case supplied two selectors that disagreed.
   *
   * The two rows are pairwise distinct on THREE observable fields — id, contentRating,
   * and which listing's edit view is read — so no single hardcoded value can satisfy the
   * assertions, and both rows are owned by the SAME user so ownership cannot be what
   * decides the outcome.
   */
  it('🔴 PRECEDENCE: `appBlockId` WINS over a slug naming a DIFFERENT listing', async () => {
    const blockRow = {
      id: 'apl_block',
      userId: OWNER,
      kind: 'onsite',
      slug: 'block-app',
      appBlockId: 'my-block',
      revisionOfId: null,
      status: 'approved',
      contentRating: 'pg13',
      appBlock: { app: { userId: OWNER } },
    };
    const slugRow = {
      id: 'apl_other',
      userId: OWNER,
      kind: 'offsite',
      slug: 'other-app',
      appBlockId: null,
      revisionOfId: null,
      status: 'approved',
      contentRating: 'g',
    };
    const byId: Record<string, unknown> = { apl_block: blockRow, apl_other: slugRow };
    const views: Record<string, unknown> = {
      apl_block: editViewRow('apls_block'),
      apl_other: editViewRow('apls_other'),
    };
    const impl = async (args: unknown) => {
      const a = args as {
        select?: Record<string, unknown>;
        where?: { id?: string; appBlockId?: string };
      };
      if (a.where?.appBlockId != null) return blockRow;
      if ('icon' in (a.select ?? {})) return views[a.where?.id ?? ''] ?? null;
      // Both listings resolve their OWNER, so a mutant that lands on the slug row is
      // refused by the identity assertions below rather than by NOT_OWNED.
      return byId[a.where?.id ?? ''] ?? null;
    };
    mockRead.appListing.findUnique.mockImplementation(impl);
    mockWrite.appListing.findUnique.mockImplementation(impl);
    wireSlugLookup([slugRow]);
    withShadow(null);

    const res = await getMyListingForApp({
      appBlockId: 'my-block',
      slug: 'other-app',
      userId: OWNER,
    });

    expect(res.appListingId).toBe('apl_block');
    expect(res.contentRating).toBe('pg13');
    // 🔴 SHORT-CIRCUIT, not last-write-wins: the slug query is never even issued.
    expect(mockRead.appListing.findFirst).not.toHaveBeenCalled();
    // …and the assets projected are the BLOCK listing's, not the slug listing's.
    expect(editViewReads(mockRead)).toEqual(['apl_block']);
  });

  it('a draft owned by ANOTHER user → NOT_OWNED (ownership still enforced on the slug path)', async () => {
    // The row is wired on BOTH lookups so the refusal is attributable to OWNERSHIP. With
    // only the slug lookup wired, the ownership resolve finds nothing and denies for
    // "listing not found" — the right verdict for the wrong reason, which would survive a
    // mutant that deleted the owner comparison entirely.
    const draft = {
      id: 'apl_draft',
      userId: OTHER,
      kind: 'onsite',
      appBlockId: null,
      revisionOfId: null,
      status: 'draft',
      contentRating: 'g',
    };
    mockRead.appListing.findFirst.mockResolvedValue(draft);
    wireFindUnique({ entry: null, owned: draft });

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

  // -------------------------------------------------------------------------
  // 🔴 civitai/civitai#3984 — the arm used to read
  // `{ slug, kind: 'onsite', appBlockId: null, status: 'draft' }`, whose FIRST clause
  // alone excludes every off-site listing: `kind: 'offsite'` is what it IS. And in
  // practice an off-site listing carries no AppBlock either, so the other selector could
  // not address it — every listing-media surface hosted on this proc was unreachable for
  // non-web clients. Measured against civitai.com at civitai/cli@1b20b99
  // (civitai/cli#422, #424): 4/4 off-site apps failed, 7/7 on-site passed, and `kind`
  // predicted it exactly.
  //
  // 🟡 "off-site ⇒ no AppBlock" is EMPIRICAL, not structural, and this file does not
  // depend on it: `appBlockId` is "set for EVERY backfilled row — on-site AND the #2821
  // off-site rows … discriminate on `kind`, never on appBlockId nullness"
  // (schema.full.prisma), and `mapAppBlockToListing` can mint `kind:'offsite'` with a
  // non-null `appBlockId` — a shape measured at 0 rows in production on 2026-08-11
  // (`appListingEditorTabs.ts`). The `kind` clause is what the widening had to drop;
  // dropping the `appBlockId` clause covers the backfilled class too.
  // -------------------------------------------------------------------------

  /** An OFF-SITE listing with no AppBlock — the common shape; the slug is its handle. */
  const offsiteRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'apl_offsite',
    userId: OWNER,
    kind: 'offsite',
    slug: 'radio',
    appBlockId: null,
    revisionOfId: null,
    status: 'approved',
    contentRating: 'g',
    ...overrides,
  });

  it('🔴 an OFF-SITE listing resolves BY SLUG — the kind clause is gone', async () => {
    const offsite = offsiteRow();
    wireSlugLookup([offsite]);
    wireFindUnique({
      entry: null,
      owned: offsite,
      viewByListingId: { apl_offsite: editViewRow('apls_offsite') },
    });
    // Approved parent, no shadow minted yet → edited in place, nothing written.
    withShadow(null);

    const res = await getMyListingForApp({ slug: 'radio', userId: OWNER });

    expect(res).toMatchObject({
      appListingId: 'apl_offsite',
      status: 'approved',
      editTargetId: 'apl_offsite',
      editBlockedReason: null,
      shadowId: null,
    });
    // The whole point of the proc: the caller now holds the AppListing.id every
    // listing-media surface is keyed on, plus the assets the publish floor checks.
    expect(res.assets.icon.imageId).toBe(137918008);
    expect(res.assets.cover.imageId).toBe(137918011);
    // It is a READ. Resolving an off-site listing must not mint anything.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('🔴 an APPROVED ON-SITE listing resolves BY SLUG — the status clause is gone', async () => {
    // An approved on-site app DOES carry an appBlockId; a client that only knows the
    // slug still could not reach it, because the fallback demanded `status: 'draft'`
    // AND `appBlockId: null`. Both are gone.
    const approved = {
      id: 'apl_live',
      userId: OWNER,
      kind: 'onsite',
      slug: 'gen-matrix',
      appBlockId: 'ab_live',
      revisionOfId: null,
      status: 'approved',
      contentRating: 'pg13',
      // The CANONICAL onsite owner is the block's app owner, not the denormalized
      // column — wire it so the gate resolves through the path it uses in production.
      appBlock: { app: { userId: OWNER } },
    };
    wireSlugLookup([approved]);
    wireFindUnique({
      entry: null,
      owned: approved,
      viewByListingId: { apl_live: editViewRow('apls_live') },
    });
    withShadow(null);

    const res = await getMyListingForApp({ slug: 'gen-matrix', userId: OWNER });

    expect(res).toMatchObject({
      appListingId: 'apl_live',
      status: 'approved',
      editTargetId: 'apl_live',
      editBlockedReason: null,
    });
    // Slug-only in, so the `appBlockId` findUnique arm was never entered.
    expect(
      mockRead.appListing.findUnique.mock.calls.some(
        ([a]) => (a as { where?: { appBlockId?: string } })?.where?.appBlockId != null
      )
    ).toBe(false);
  });

  /**
   * 🔴 "ANY STATUS" IS A BEHAVIOURAL CLAIM, so it gets behavioural cases. Before these,
   * the widening was only SPELLED — the sole thing that noticed a status narrowing was
   * the structural `toHaveBeenCalledWith` pin on the draft case, and no case actually
   * admitted a TERMINAL listing by slug. Measured: adding `status: { not: 'removed' }`
   * back to the `where` killed exactly that one structural assertion and nothing else,
   * so the `describe` title's "any status" was an unbacked claim.
   *
   * The two terminal statuses are the ones with something to say: they resolve, and come
   * back as a VERDICT (`editBlockedReason`) rather than a throw — the same
   * "don't collapse to NotFound" contract the `appBlockId` arm already has, now reachable
   * by slug. One row per status, so a narrowing on EITHER one is caught.
   */
  it.each([
    ['removed', 'this listing has been removed by a moderator and can no longer be edited'],
    ['rejected', 'this listing was rejected; submit a new listing instead of editing it'],
  ])(
    '🔴 a %s listing RESOLVES BY SLUG and returns its editBlockedReason (any status)',
    async (status, expected) => {
      const dead = offsiteRow({ id: 'apl_dead', slug: 'dead-app', status });
      wireSlugLookup([dead]);
      wireFindUnique({
        entry: null,
        owned: dead,
        viewByListingId: { apl_dead: editViewRow('apls_dead') },
      });

      const res = await getMyListingForApp({ slug: 'dead-app', userId: OWNER });

      // It RESOLVED — a status narrowing on the `where` would throw NOT_FOUND here.
      expect(res.appListingId).toBe('apl_dead');
      expect(res.status).toBe(status);
      // …and it came back as a verdict the surface can render, not an error.
      expect(res.editBlockedReason).toBe(expected);
      // Still a READ: a terminal listing must not mint a shadow on the way out.
      expect(mockWrite.appListing.create).not.toHaveBeenCalled();
    }
  );

  it('🔴 a slug owned by ANOTHER user → NOT_OWNED, not NOT_FOUND (the gate, not the where)', async () => {
    // The BEHAVIOUR DELTA of #3984, pinned deliberately. Before, a stranger's slug was
    // filtered out by the `where` and reported NOT_FOUND; now the row resolves and the
    // OWNER GATE refuses it — which is what makes the gate, rather than an incidental
    // clause, the thing enforcing access. Wired on BOTH lookups so the refusal is
    // attributable to ownership and not to the ownership resolve finding nothing.
    const strangers = offsiteRow({ userId: OTHER });
    wireSlugLookup([strangers]);
    wireFindUnique({ entry: null, owned: strangers });

    await expect(getMyListingForApp({ slug: 'radio', userId: OWNER })).rejects.toMatchObject({
      name: 'OffsiteRequestError',
      code: 'NOT_OWNED',
    });
    // Refused before anything else is read.
    expect(mockRead.appListingPublishRequest.findFirst).not.toHaveBeenCalled();
  });

  it('🔴 a SHADOW revision’s synthetic `rev-` slug does NOT resolve → NOT_FOUND', async () => {
    // `revisionOfId: null` is the one clause that had to STAY, and it is not
    // decoration: a shadow is `kind: parent.kind`, `appBlockId` NULL, status `draft`
    // (`beginListingRevision`). For an ON-SITE parent — the fixture below — that is
    // exactly the old, apparently-narrower clause, so those shadows MATCHED it; a
    // shadow of an OFF-SITE parent is `kind:'offsite'` and did not. Either way the old
    // comment's "only ever sees a parent" held only because nobody knows a `rev-<ulid>`
    // slug. Now it holds by construction, and this clause is the ONLY thing holding it.
    const shadow = {
      id: 'apl_shadow',
      userId: OWNER,
      kind: 'onsite',
      slug: 'rev-01JABCDEF',
      appBlockId: null,
      revisionOfId: 'apl_parent',
      status: 'draft',
      contentRating: 'g',
    };
    wireSlugLookup([shadow]);
    // 🔴 The edit view IS wired, and that is what makes this test discriminating. With
    // it absent, a resolver that DID admit the shadow would still throw NOT_FOUND —
    // from `loadListingEditView` missing its row, several steps later — and this case
    // would pass under the very clause it exists to reject. Measured: it did exactly
    // that on the first draft of this test. Wired, an admitted shadow RESOLVES and
    // returns an `editBlockedReason` result, so the assertions below are the only
    // thing standing between the two behaviours.
    wireFindUnique({
      entry: null,
      owned: shadow,
      viewByListingId: { apl_shadow: editViewRow('apls_shadow') },
    });

    const err = await getMyListingForApp({ slug: 'rev-01JABCDEF', userId: OWNER }).catch((e) => e);

    expect(err).toBeInstanceOf(OffsiteRequestError);
    expect(err.code).toBe('NOT_FOUND');
    // Refused by the RESOLVER, not by the owner gate and not by a later read: the
    // caller owns this shadow, and the message names the unresolved slug.
    expect(err.message).toBe('no listing found for app rev-01JABCDEF');
  });
});
