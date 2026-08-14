import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE DRIFTED ON-SITE LISTING — one fixture, five gates, both directions.
 *
 * `AppListing.userId` is the CANONICAL owner for an OFF-SITE listing and a DENORMALIZED
 * COPY for an ON-SITE one, whose real owner is `OauthClient.userId` reached as
 * `AppListing.appBlock.app.userId`. Five production gates used to compare the caller
 * against that copy, and on a drifted row a comparison like that fails in BOTH directions
 * at once:
 *
 *   - the REAL owner is refused on their own listing — and refused twice over, because
 *     the collaborator fallback resolves them as `owner`, which is not `editor`; and
 *   - whoever the stale row happens to name walks straight through the first comparison,
 *     reaching the listing's media, its revision submit and (via the roster) the
 *     `displayed:false` seats.
 *
 * Every case below therefore asserts the PAIR. Asserting only the refusal would leave a
 * "deny everyone" mutant alive; asserting only the admission would leave "allow
 * everyone" alive. The seated EDITOR and the STRANGER cases are here for the same
 * reason — the fix must move the OWNER half onto the canonical resolution without
 * touching the seat half in either direction.
 *
 * 🔴 WHERE A DRIFTED ROW ACTUALLY COMES FROM — stated exactly, because the first version
 * of this file named the wrong mechanism and a wrong mechanism sends the next reader to
 * the wrong file. It is a SHADOW REVISION:
 *
 *   - `beginListingRevision` clones the approved parent into a hidden draft with
 *     `userId: parent.userId` (a copy of a copy) and `appBlockId: null`;
 *   - `acceptTransfer` step 3 updates only `{ id: <the transferred listing> }` — it never
 *     touches that listing's shadows — and `applyApprovedRevision` copies assets back to
 *     the parent, never `userId`;
 *   - so a shadow that outlives a transfer of its parent keeps the OLD owner FROZEN,
 *     while the parent and the `OauthClient` both name the new one. A gate that reads the
 *     shadow's own column reads that frozen value.
 *
 * 🔴 It is NOT `acceptTransfer`'s onsite listing write "being deliberately unguarded, a
 * 0-count an accepted desync" — that write is `where: { id }`, i.e. UNCONDITIONAL, issued
 * in the same transaction as the `OauthClient` move and after an in-tx read of the same
 * row through its own FK. It HEALS the parent's copy; a 0-count there needs the row to be
 * absent, which the pre-read precludes. And `app-ownership-transfer.service.ts` holds the
 * only in-app write to `OauthClient.userId`. So the top-level row's copy has no drift
 * mechanism; only clones of it do.
 *
 * The fixture below is therefore built as a parent PLUS its shadow, and both directions
 * are asserted on each. The parent is given the drifted value anyway — it costs nothing
 * and it is what makes each case measurable against the pre-fix code, which read the
 * column on both rows.
 *
 * 🔴 MEASURED STATE, so the stakes are stated honestly: 0 drifted rows across all 21
 * onsite listings in production on 2026-08-11, because no onsite ownership transfer has
 * ever run. This is LATENT, not live. It goes live on the first onsite transfer of a
 * listing that has an in-flight revision draft. (The rate of approved onsite parents
 * carrying a shadow is NOT measured here — `getMyListingForApp` stopped minting one per
 * page view, so the old 78% figure in `app-listing-assets.service.ts` describes the
 * pre-change world and must not be re-quoted as current.)
 *
 * The last describe block is the control that keeps the fix from over-reaching: on an
 * OFF-SITE listing the column IS the owner, so "always use the block owner" would be a
 * new bug. The kind-aware resolution has to keep admitting the column's owner there.
 */

const { mockRead, mockWrite, seq } = vi.hoisted(() => {
  const make = () => ({
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (args: { data: unknown }) => args.data),
      update: vi.fn(async (args: { data: unknown }) => args.data),
    },
    appListingScreenshot: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      count: vi.fn(async (..._a: unknown[]): Promise<number> => 0),
      createMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
    appListingPublishRequest: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (args: { data: unknown }) => args.data),
    },
    appCollaborator: { findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    image: { findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) },
    oauthClient: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(null)
        : Promise.all(arg as Promise<unknown>[])
    ),
  });
  // 🔴 TWO OBJECTS, never one shared fake. A single client makes "which pool answered?"
  // unanswerable, and the asset gates carry a pool override whose loss is a 403 for an
  // editor (see `app-collaborator.editor-read-after-write.test.ts`).
  return { mockRead: make(), mockWrite: make(), seq: { n: 0 } };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (url: string) => `edge:${url}` }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_new_${++seq.n}`,
  newAppListingPublishRequestId: () => `alpr_new_${++seq.n}`,
  newAppListingScreenshotId: () => `apls_new_${++seq.n}`,
  newUlid: () => `ULID${++seq.n}`,
}));

const { getMyListingForApp, submitListingRevision, updateListing } = await import(
  '~/server/services/blocks/offsite-listing.service'
);
const { getListingAssets, updateListingScreenshotCaption } = await import(
  '~/server/services/blocks/app-listing-assets.service'
);

// 🔴 PAIRWISE-DISTINCT ids. Two roles sharing a number is how a fixture "proves" a gate
// that is actually reading the wrong field.
const REAL_OWNER = 42; // OauthClient.userId — the canonical owner
const STALE_NAME = 99; // what the drifted AppListing.userId column still says
const EDITOR = 77; // holds an ACCEPTED seat on the parent
const STRANGER = 13; // no relationship to the listing at all

const LIVE = 'apl_live';
const SHADOW = 'apl_shadow';
const SHOT = 'apls_1';
const BLOCK = 'ab_1';

const user = (id: number) => ({ id, isModerator: false } as never);

/**
 * The drifted ON-SITE parent: the column says {@link STALE_NAME}, the OauthClient says
 * {@link REAL_OWNER}. Every select this fixture serves is a subset of these fields, so
 * one row can answer both the gate's load and the resolver's.
 */
function liveRow(over: Record<string, unknown> = {}) {
  return {
    id: LIVE,
    kind: 'onsite',
    slug: 'my-app',
    status: 'draft',
    userId: STALE_NAME,
    revisionOfId: null,
    appBlockId: BLOCK,
    appBlock: { app: { userId: REAL_OWNER } },
    name: 'My App',
    tagline: null,
    description: null,
    category: null,
    contentRating: 'g',
    externalUrl: null,
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    iconId: 101,
    coverId: 202,
    ...over,
  };
}

/**
 * The shadow revision of that parent — a COPY OF THE COPY. `beginListingRevision` clones
 * with `userId: parent.userId`, so the shadow carries the drifted value frozen at clone
 * time, and its own `appBlockId` is null by construction. Its `revisionOf` therefore has
 * to supply both what the submit path reads (`slug`, `status`) and what the resolver
 * reads (`appBlock.app.userId`).
 */
function shadowRow(over: Record<string, unknown> = {}) {
  return {
    id: SHADOW,
    kind: 'onsite',
    slug: 'rev-ulid',
    status: 'draft',
    userId: STALE_NAME,
    revisionOfId: LIVE,
    appBlockId: null,
    appBlock: null,
    externalUrl: null,
    iconId: 101,
    coverId: 202,
    revisionOf: {
      id: LIVE,
      slug: 'my-app',
      status: 'approved',
      kind: 'onsite',
      appBlockId: BLOCK,
      appBlock: { app: { userId: REAL_OWNER } },
    },
    ...over,
  };
}

/** The `loadListingEditView` projection (`getMyListingForApp`'s asset half). */
const editView = {
  name: 'My App',
  tagline: null,
  description: null,
  category: null,
  contentRating: 'g',
  externalUrl: null,
  connectRequestedScopes: null,
  connectScopeJustifications: null,
  iconId: 101,
  coverId: 202,
  icon: { url: 'icon-key' },
  cover: { url: 'cover-key' },
  screenshots: [],
};

/**
 * Route `appListing.findUnique` by call shape on BOTH pools:
 *   - `select` has `icon`  → the edit-view projection
 *   - `where.appBlockId`   → the by-block entry resolve
 *   - `where.id`           → the parent or the shadow
 */
function wireListings(rows: Record<string, unknown>) {
  const impl = async (args: unknown) => {
    const a = args as {
      select?: Record<string, unknown>;
      where?: { id?: string; appBlockId?: string };
    };
    if ('icon' in (a.select ?? {})) return editView;
    if (a.where?.appBlockId != null) return rows[LIVE] ?? null;
    return rows[a.where?.id ?? ''] ?? null;
  };
  mockRead.appListing.findUnique.mockImplementation(impl);
  mockWrite.appListing.findUnique.mockImplementation(impl);
}

/** Give `userId` an ACCEPTED seat on every listing, on both pools. */
function seatFor(userId: number) {
  const impl = async (args: unknown) => {
    const w = (args as { where: { userId: number; status?: string } }).where;
    return w.userId === userId && w.status === 'accepted' ? { userId } : null;
  };
  mockRead.appCollaborator.findFirst.mockImplementation(impl);
  mockWrite.appCollaborator.findFirst.mockImplementation(impl);
}

beforeEach(() => {
  vi.clearAllMocks();
  seq.n = 0;
  for (const db of [mockRead, mockWrite]) {
    db.appListing.findFirst.mockResolvedValue(null);
    db.appListing.update.mockImplementation(async (a: { data: unknown }) => a.data);
    db.appListingScreenshot.findMany.mockResolvedValue([]);
    db.appListingScreenshot.count.mockResolvedValue(0);
    db.appListingScreenshot.updateMany.mockResolvedValue({ count: 1 });
    db.appListingPublishRequest.findFirst.mockResolvedValue(null);
    db.appCollaborator.findFirst.mockResolvedValue(null);
    db.image.findMany.mockResolvedValue([]);
    db.$transaction.mockImplementation(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(mockWrite)
        : Promise.all(arg as Promise<unknown>[])
    );
  }
  // `appListing.userId` is no longer SELECTED by the screenshot resolve (the gate that
  // read it is gone), but the relation still exists on the real row and the fixture keeps
  // it: it is what makes this suite measurable against the PRE-FIX code, where the same
  // call reads it and admits the stale name. Without it the pre-fix run dies on a
  // TypeError — a failure that proves nothing about the gate.
  const shot = { id: SHOT, appListingId: LIVE, appListing: { userId: STALE_NAME } };
  mockRead.appListingScreenshot.findUnique.mockResolvedValue(shot);
  mockWrite.appListingScreenshot.findUnique.mockResolvedValue(shot);
  wireListings({ [LIVE]: liveRow(), [SHADOW]: shadowRow() });
});

describe('🔴 POSITIVE CONTROL: the fixture really is drifted', () => {
  it('the column and the OauthClient name DIFFERENT users', () => {
    // Without this, every assertion below could be passing because the two ids happen to
    // agree — the fixture would prove nothing about which one is being read.
    expect(liveRow().userId).toBe(STALE_NAME);
    expect(liveRow().appBlock.app.userId).toBe(REAL_OWNER);
    expect(STALE_NAME).not.toBe(REAL_OWNER);
    // The shadow inherited the drift rather than fixing it.
    expect(shadowRow().userId).toBe(STALE_NAME);
    expect(shadowRow().appBlockId).toBeNull();
  });
});

describe('offsite-listing::loadOwnedEditableListing (via updateListing)', () => {
  it('ADMITS the real owner', async () => {
    await expect(
      updateListing({ listingId: LIVE, patch: { name: 'Renamed' }, userId: REAL_OWNER })
    ).resolves.toMatchObject({ listingId: LIVE, status: 'draft', requiresReview: false });
    expect(mockWrite.appListing.update).toHaveBeenCalledOnce();
  });

  it('REFUSES the stale name the column still carries', async () => {
    await expect(
      updateListing({ listingId: LIVE, patch: { name: 'Renamed' }, userId: STALE_NAME })
    ).rejects.toMatchObject({
      code: 'NOT_OWNED',
      message: 'you can only edit your own listings',
    });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('still admits an ACCEPTED editor, and still refuses a stranger', async () => {
    seatFor(EDITOR);
    await expect(
      updateListing({ listingId: LIVE, patch: { name: 'Renamed' }, userId: EDITOR })
    ).resolves.toMatchObject({ listingId: LIVE });
    await expect(
      updateListing({ listingId: LIVE, patch: { name: 'Renamed' }, userId: STRANGER })
    ).rejects.toMatchObject({ code: 'NOT_OWNED' });
  });
});

describe('🔴 D1: offsite-listing has NO moderator bypass — behaviourally, not as a string', () => {
  /**
   * D1 is the decision that `offsite-listing.service`'s author gates admit ONLY the
   * owner and an accepted editor, while its sibling `app-listing-assets.service` also
   * lets a moderator through. Until now that decision existed as prose in
   * `app-access.call-site-ledger.test.ts` and as a comment on `loadOwnedEditableListing`
   * — and a LEDGER STRING IS NOT A GUARD. A mutant that threads `isModerator` into
   * `loadOwnedEditableListing` and short-circuits on it leaves the entire blocks suite
   * green, and the comments there explicitly anticipate a future "make the mod bypass
   * consistent" edit — which would silently widen an AUTHOR edit path to every moderator.
   *
   * `updateListing` already accepts `isModerator` (it is threaded into `deriveScopePatch`
   * so a mod editing a listing that links a foreign OAuth client is not blocked by the
   * client re-assertion), so the flag reaching the function is not hypothetical: it is
   * already in the signature, one line away from the gate. These cases pin that it does
   * NOT reach the gate.
   */
  it('a moderator who is not the owner is REFUSED on an ON-SITE listing', async () => {
    await expect(
      updateListing({
        listingId: LIVE,
        patch: { name: 'Renamed' },
        userId: STRANGER,
        isModerator: true,
      })
    ).rejects.toMatchObject({ code: 'NOT_OWNED', message: 'you can only edit your own listings' });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('a moderator who is not the owner is REFUSED on an OFF-SITE listing', async () => {
    // The kind D1 is named for. Same refusal, so the decision is not an artefact of the
    // drifted onsite fixture.
    wireListings({
      [LIVE]: liveRow({
        kind: 'offsite',
        userId: REAL_OWNER,
        externalUrl: 'https://example.com/',
        appBlockId: null,
        appBlock: null,
      }),
    });
    await expect(
      updateListing({
        listingId: LIVE,
        patch: { name: 'Renamed' },
        userId: STRANGER,
        isModerator: true,
      })
    ).rejects.toMatchObject({ code: 'NOT_OWNED' });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('🔴 POSITIVE CONTROL: the flag is accepted and the owner still gets through with it', async () => {
    // Without this, the two refusals above are indistinguishable from `isModerator` being
    // an unknown key that never reaches anything — a reassuring zero. This proves the
    // same call shape SUCCEEDS when the caller is the owner, so the refusals are the
    // gate's verdict on the CALLER, not on the argument.
    await expect(
      updateListing({
        listingId: LIVE,
        patch: { name: 'Renamed' },
        userId: REAL_OWNER,
        isModerator: true,
      })
    ).resolves.toMatchObject({ listingId: LIVE });
    expect(mockWrite.appListing.update).toHaveBeenCalledOnce();
  });

  it('🔴 CROSS-FILE CONTROL: the SAME non-owner moderator IS admitted by the assets gate', async () => {
    // D1 is a claim about a DIVERGENCE between two sibling gates, so asserting only the
    // refusal would leave "mods are refused everywhere" indistinguishable from it. The
    // asset path's bypass is live and must stay live; that is what makes the offsite
    // refusal above a decision rather than an oversight.
    await expect(
      getListingAssets({ listingId: LIVE }, { id: STRANGER, isModerator: true } as never)
    ).resolves.toMatchObject({ listingId: LIVE });
  });
});

describe('offsite-listing::submitListingRevision', () => {
  it('ADMITS the real owner (resolved through the shadow’s PARENT)', async () => {
    await expect(
      submitListingRevision({ shadowId: SHADOW, userId: REAL_OWNER })
    ).resolves.toMatchObject({ shadowId: SHADOW, slug: 'my-app' });
    expect(mockWrite.appListingPublishRequest.create).toHaveBeenCalledOnce();
  });

  it('REFUSES the stale name', async () => {
    await expect(
      submitListingRevision({ shadowId: SHADOW, userId: STALE_NAME })
    ).rejects.toMatchObject({
      code: 'NOT_OWNED',
      message: 'you can only submit your own revision',
    });
    expect(mockWrite.appListingPublishRequest.create).not.toHaveBeenCalled();
  });

  it('still admits an ACCEPTED editor on the parent, and still refuses a stranger', async () => {
    // The seat lives on the PARENT — the resolver hops there. This is the case the bare
    // comparison could never serve: the shadow's column names the (stale) parent owner,
    // never the editor.
    seatFor(EDITOR);
    await expect(
      submitListingRevision({ shadowId: SHADOW, userId: EDITOR })
    ).resolves.toMatchObject({ shadowId: SHADOW });
    await expect(
      submitListingRevision({ shadowId: SHADOW, userId: STRANGER })
    ).rejects.toMatchObject({ code: 'NOT_OWNED' });
  });
});

describe('offsite-listing::getMyListingForApp', () => {
  // 🔴 SCOPE NOTE, so this block is not read as more than it is. Unlike the other four
  // sites, this one cannot be handed a shadow id — it resolves its row by `appBlockId` or
  // `slug`, so it only ever sees a top-level parent, and a parent's copy has no drift
  // mechanism (see the file header). The fixture below is therefore a state production
  // cannot reach on THIS path. The cases still earn their place: they pin WHICH FIELD the
  // gate reads, which is what keeps the fifth site from being the one that quietly keeps
  // its own spelling of the predicate.
  it('ADMITS the real owner', async () => {
    await expect(
      getMyListingForApp({ appBlockId: BLOCK, userId: REAL_OWNER })
    ).resolves.toMatchObject({ appListingId: LIVE, status: 'draft' });
  });

  it('REFUSES the stale name', async () => {
    await expect(
      getMyListingForApp({ appBlockId: BLOCK, userId: STALE_NAME })
    ).rejects.toMatchObject({
      code: 'NOT_OWNED',
      message: 'you can only manage your own listings',
    });
  });

  it('still admits an ACCEPTED editor, and still refuses a stranger', async () => {
    seatFor(EDITOR);
    await expect(getMyListingForApp({ appBlockId: BLOCK, userId: EDITOR })).resolves.toMatchObject({
      appListingId: LIVE,
    });
    await expect(getMyListingForApp({ appBlockId: BLOCK, userId: STRANGER })).rejects.toMatchObject(
      { code: 'NOT_OWNED' }
    );
  });
});

describe('app-listing-assets::loadOwnedListing (via getListingAssets)', () => {
  it('ADMITS the real owner', async () => {
    await expect(getListingAssets({ listingId: LIVE }, user(REAL_OWNER))).resolves.toMatchObject({
      listingId: LIVE,
    });
  });

  it('REFUSES the stale name', async () => {
    await expect(getListingAssets({ listingId: LIVE }, user(STALE_NAME))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not own this listing',
    });
  });

  it('still admits an ACCEPTED editor, and still refuses a stranger', async () => {
    seatFor(EDITOR);
    await expect(getListingAssets({ listingId: LIVE }, user(EDITOR))).resolves.toMatchObject({
      listingId: LIVE,
    });
    await expect(getListingAssets({ listingId: LIVE }, user(STRANGER))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('🔴 the mod bypass survives AND still short-circuits before the resolve', async () => {
    // The mod bypass (D1) is this file's alone and must survive the consolidation. The
    // second half of that sentence used to be an unasserted claim — "a mod pays no extra
    // query" appeared in the comment while nothing counted the calls, so a mutant that
    // moved the `isModerator` check AFTER the resolve would have kept this green.
    // Counting it is the whole point, so it is counted, with a positive control.
    seatFor(EDITOR);
    await expect(
      getListingAssets({ listingId: LIVE }, { id: STRANGER, isModerator: true } as never)
    ).resolves.toMatchObject({ listingId: LIVE });
    expect(mockRead.appCollaborator.findFirst).not.toHaveBeenCalled();
    expect(mockWrite.appCollaborator.findFirst).not.toHaveBeenCalled();

    // POSITIVE CONTROL: the seat lookup is reachable from this very call shape — the only
    // thing that changed is who is asking. Without it, "0 calls" is indistinguishable
    // from a seat lookup this path never performs for anyone.
    await expect(getListingAssets({ listingId: LIVE }, user(EDITOR))).resolves.toMatchObject({
      listingId: LIVE,
    });
    expect(
      mockRead.appCollaborator.findFirst.mock.calls.length +
        mockWrite.appCollaborator.findFirst.mock.calls.length
    ).toBe(1);
  });
});

describe('app-listing-assets::resolveOwnerScreenshotTarget (via updateListingScreenshotCaption)', () => {
  // The fifth site. Its own early gate — a second, denormalized-column copy of
  // `loadOwnedListing`'s question about the same listing — is gone; these cases pin that
  // its removal left the path GATED, and gated CORRECTLY, rather than merely quieter.
  it('ADMITS the real owner', async () => {
    await expect(
      updateListingScreenshotCaption({ screenshotId: SHOT, caption: 'hi' }, user(REAL_OWNER))
    ).resolves.toEqual({ id: SHOT });
    expect(mockWrite.appListingScreenshot.updateMany).toHaveBeenCalledOnce();
  });

  it('REFUSES the stale name — and writes nothing', async () => {
    await expect(
      updateListingScreenshotCaption({ screenshotId: SHOT, caption: 'hi' }, user(STALE_NAME))
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'You do not own this listing' });
    expect(mockWrite.appListingScreenshot.updateMany).not.toHaveBeenCalled();
  });

  it('still refuses a stranger', async () => {
    await expect(
      updateListingScreenshotCaption({ screenshotId: SHOT, caption: 'hi' }, user(STRANGER))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockWrite.appListingScreenshot.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 ISSUE #3844, DRIVEN THROUGH ALL FIVE GATES — the same table twice, once per arm.
 *
 * The suites above pin the ON-SITE drift. These pin the OFF-SITE inversion the
 * consolidation introduced, and they do it as a TABLE over the whole gate population
 * rather than by sampling one gate: the population is every consumer of
 * `resolveListingAccess` in these two services, and each is asserted in BOTH directions.
 * A gate that only granted would leave "allow everyone" alive; one that only refused would
 * leave "deny everyone" alive.
 *
 * The resolver-level assertions (and the `claimListing` seam) live in
 * `app-access.kind-aware-owner.test.ts`; this file is the end-to-end half.
 */
const OFFSITE_GATES: Array<{
  name: string;
  /** Which fixture row this gate is entered through. */
  entry: 'live' | 'shadow';
  run: (userId: number) => Promise<unknown>;
  granted: Record<string, unknown>;
  refused: Record<string, unknown>;
}> = [
  {
    name: 'offsite-listing::loadOwnedEditableListing (updateListing)',
    entry: 'live',
    run: (userId) => updateListing({ listingId: LIVE, patch: { name: 'Renamed' }, userId }),
    granted: { listingId: LIVE },
    refused: { code: 'NOT_OWNED', message: 'you can only edit your own listings' },
  },
  {
    name: 'offsite-listing::getMyListingForApp',
    entry: 'live',
    run: (userId) => getMyListingForApp({ appBlockId: BLOCK, userId }),
    granted: { appListingId: LIVE },
    refused: { code: 'NOT_OWNED', message: 'you can only manage your own listings' },
  },
  {
    name: 'app-listing-assets::loadOwnedListing (getListingAssets)',
    entry: 'live',
    run: (userId) => getListingAssets({ listingId: LIVE }, user(userId)),
    granted: { listingId: LIVE },
    refused: { code: 'FORBIDDEN', message: 'You do not own this listing' },
  },
  {
    name: 'app-listing-assets::resolveOwnerScreenshotTarget (updateListingScreenshotCaption)',
    entry: 'live',
    run: (userId) =>
      updateListingScreenshotCaption({ screenshotId: SHOT, caption: 'hi' }, user(userId)),
    granted: { id: SHOT },
    refused: { code: 'FORBIDDEN', message: 'You do not own this listing' },
  },
  {
    name: 'offsite-listing::submitListingRevision',
    entry: 'shadow',
    run: (userId) => submitListingRevision({ shadowId: SHADOW, userId }),
    granted: { shadowId: SHADOW },
    refused: { code: 'NOT_OWNED', message: 'you can only submit your own revision' },
  },
];

describe('🔴 #3844 ARM 1 — an OFF-SITE listing that CARRIES A BLOCK: the block must not decide', () => {
  /**
   * `mapAppBlockToListing` mints exactly this shape from an `AppBlock` with an
   * `externalUrl`. The column names {@link REAL_OWNER}; the attached block names
   * {@link STRANGER} — who, in the story this models, is the ex-owner or the impersonator
   * `claimListing` just dispossessed, since both off-site ownership writers move only the
   * column and leave the block naming whoever it named before.
   */
  const offsiteBlockParent = {
    id: LIVE,
    kind: 'offsite',
    slug: 'my-app',
    // `draft`, matching `liveRow()`: an APPROVED parent routes a material edit through
    // `beginListingRevision`, which is a different code path and not what these gates are
    // about. The shadow's own `revisionOf.status` below still says `approved`, exactly as
    // the on-site fixture does.
    status: 'draft',
    userId: REAL_OWNER,
    revisionOfId: null,
    appBlockId: BLOCK,
    appBlock: { app: { userId: STRANGER } },
    name: 'My App',
    tagline: null,
    description: null,
    category: null,
    contentRating: 'g',
    externalUrl: 'https://example.com/',
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    iconId: 101,
    coverId: 202,
  };
  const offsiteBlockShadow = {
    ...shadowRow(),
    kind: 'offsite',
    // Frozen at clone time from the parent's column — the SAME user, so this arm varies
    // only the block. Arm 2 below varies only the frozen column.
    userId: REAL_OWNER,
    externalUrl: 'https://example.com/',
    revisionOf: {
      id: LIVE,
      slug: 'my-app',
      status: 'approved',
      kind: 'offsite',
      // The PARENT's column — what the resolver must read for an off-site listing. Equal
      // to the shadow's here on purpose: this arm varies the BLOCK and nothing else.
      userId: REAL_OWNER,
      appBlockId: BLOCK,
      appBlock: { app: { userId: STRANGER } },
    },
  };

  beforeEach(() => {
    wireListings({ [LIVE]: offsiteBlockParent, [SHADOW]: offsiteBlockShadow });
  });

  it('🔴 POSITIVE CONTROL: the fixture is offsite, HAS a block, and the two owners differ', () => {
    expect(offsiteBlockParent.kind).toBe('offsite');
    expect(offsiteBlockParent.appBlockId).toBe(BLOCK);
    expect(offsiteBlockParent.userId).toBe(REAL_OWNER);
    expect(offsiteBlockParent.appBlock.app.userId).toBe(STRANGER);
    expect(REAL_OWNER).not.toBe(STRANGER);
  });

  for (const gate of OFFSITE_GATES) {
    it(`${gate.name} ADMITS the rightful (column) owner`, async () => {
      await expect(gate.run(REAL_OWNER)).resolves.toMatchObject(gate.granted);
    });

    it(`${gate.name} REFUSES the user the attached block names`, async () => {
      await expect(gate.run(STRANGER)).rejects.toMatchObject(gate.refused);
    });
  }
});

describe('🔴 #3844 ARM 2 — an OFF-SITE SHADOW must not freeze the pre-transfer owner', () => {
  /**
   * The arm that needs NO block, and therefore no unmintable shape:
   * `beginListingRevision` clones the parent with `userId: parent.userId`, and neither
   * `claimListing` nor `acceptTransfer`'s off-site path touches a shadow (both write
   * `where: { id: <the parent> }`). So a shadow that outlives an off-site ownership move
   * names the OLD owner forever, and for `offsite` the column is exactly what the resolver
   * falls back to. Only the two shadow-reachable gates apply.
   */
  const offsiteParent = {
    ...liveRow(),
    kind: 'offsite',
    userId: REAL_OWNER, // the ownership move already landed here
    appBlockId: null,
    appBlock: null,
    externalUrl: 'https://example.com/',
  };
  const staleShadow = {
    ...shadowRow(),
    kind: 'offsite',
    userId: STALE_NAME, // frozen at clone time, before the move
    externalUrl: 'https://example.com/',
    revisionOf: {
      id: LIVE,
      slug: 'my-app',
      status: 'approved',
      kind: 'offsite',
      // 🔴 The PARENT's column, which the move DID update. This arm varies exactly this
      // one field against the shadow's frozen copy — no block anywhere in the fixture.
      userId: REAL_OWNER,
      appBlockId: null,
      appBlock: null,
    },
  };

  beforeEach(() => {
    wireListings({ [LIVE]: offsiteParent, [SHADOW]: staleShadow });
  });

  it('🔴 POSITIVE CONTROL: the shadow’s frozen column disagrees with its parent’s', () => {
    expect(staleShadow.userId).toBe(STALE_NAME);
    expect(offsiteParent.userId).toBe(REAL_OWNER);
    expect(staleShadow.revisionOfId).toBe(LIVE);
    expect(staleShadow.appBlockId).toBeNull();
  });

  it('submitListingRevision ADMITS the parent’s CURRENT owner', async () => {
    await expect(
      submitListingRevision({ shadowId: SHADOW, userId: REAL_OWNER })
    ).resolves.toMatchObject({ shadowId: SHADOW });
  });

  it('submitListingRevision REFUSES the ex-owner the shadow still names', async () => {
    await expect(
      submitListingRevision({ shadowId: SHADOW, userId: STALE_NAME })
    ).rejects.toMatchObject({
      code: 'NOT_OWNED',
      message: 'you can only submit your own revision',
    });
  });

  it('the asset gate on the SHADOW admits the current owner and refuses the frozen one', async () => {
    await expect(getListingAssets({ listingId: SHADOW }, user(REAL_OWNER))).resolves.toMatchObject({
      listingId: SHADOW,
    });
    await expect(getListingAssets({ listingId: SHADOW }, user(STALE_NAME))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not own this listing',
    });
  });

  it('an editor seated on the PARENT still reaches the shadow', async () => {
    // The fix must move the OWNER half without disturbing the seat half.
    seatFor(EDITOR);
    await expect(
      submitListingRevision({ shadowId: SHADOW, userId: EDITOR })
    ).resolves.toMatchObject({
      shadowId: SHADOW,
    });
  });
});

describe('🔴 THE OTHER DIRECTION: an OFF-SITE listing’s column IS the owner', () => {
  // The control on the fix itself. "Always take the block owner" would be a NEW inversion
  // — an off-site listing has no OauthClient in its ownership chain, so `AppListing.userId`
  // is canonical there and the fallback must be exact. An off-site row that nonetheless
  // carries a block (`mapAppBlockToListing` mints exactly that shape from an AppBlock with
  // an externalUrl) is the sharpest case: the block is present and must still not decide
  // ownership.
  const offsite = (over: Record<string, unknown> = {}) =>
    liveRow({
      kind: 'offsite',
      userId: REAL_OWNER,
      externalUrl: 'https://example.com/',
      appBlockId: null,
      appBlock: null,
      ...over,
    });

  it('the column’s owner is admitted; a stranger is refused', async () => {
    wireListings({ [LIVE]: offsite() });
    await expect(
      updateListing({ listingId: LIVE, patch: { name: 'Renamed' }, userId: REAL_OWNER })
    ).resolves.toMatchObject({ listingId: LIVE });
    await expect(
      updateListing({ listingId: LIVE, patch: { name: 'Renamed' }, userId: STRANGER })
    ).rejects.toMatchObject({ code: 'NOT_OWNED' });
  });

  it('🔴 FIXED (issue #3844): offsite + a block ⇒ the COLUMN still wins, the block does not', async () => {
    // 🔴 THIS CASE WAS INVERTED, DELIBERATELY, AND THE OLD EXPECTATION IS RECORDED HERE
    // SO NOBODY RE-DERIVES IT. Until #3844 it asserted the opposite — that the BLOCK
    // decides on this shape — and called itself a KNOWN REGRESSION: PR #3840 routed five
    // gates through `resolveListingAccess`, whose resolution was `appBlock.app.userId ??
    // listing.userId` (BLOCK-FIRST, no branch on `kind`). That read as "kind-aware" only
    // because an ordinary off-site listing has no block.
    //
    // `mapAppBlockToListing` mints `kind:'offsite'` WITH an `appBlockId` from any
    // `AppBlock` carrying an `externalUrl`, and BOTH off-site ownership writers move only
    // the column:
    //   - `acceptTransfer` — its step (2) OauthClient move is `if (isOnsite)`-guarded;
    //   - `claimListing` — the mod impersonation remedy (report → delist → claim → ban),
    //     which refuses a non-offsite listing outright and writes only the column.
    // So block-first kept the ex-owner — or the impersonator the claim was meant to
    // dispossess — in edit access, and refused the rightful owner. Both directions are
    // asserted below, and the impersonation-remedy path has its own suite in
    // `app-access.kind-aware-owner.test.ts`.
    //
    // The shape was measured UNMINTABLE on 2026-08-12 (`kind='offsite' AND app_block_id
    // IS NOT NULL` → 0 rows; 0 of 22 `app_blocks` carry an `external_url`; no writer of
    // that column in `src/server`), so this was a LATENT inversion closed before anything
    // could mint it — not a live exploit.
    wireListings({
      [LIVE]: offsite({ appBlockId: BLOCK, appBlock: { app: { userId: STRANGER } } }),
    });
    // The listing's own column is canonical for offsite: its owner is admitted…
    await expect(getListingAssets({ listingId: LIVE }, user(REAL_OWNER))).resolves.toMatchObject({
      listingId: LIVE,
    });
    // …and the user the attached block names is a stranger, refused. Asserting only the
    // first half would leave an "allow everyone" mutant alive.
    await expect(getListingAssets({ listingId: LIVE }, user(STRANGER))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not own this listing',
    });
  });
});
