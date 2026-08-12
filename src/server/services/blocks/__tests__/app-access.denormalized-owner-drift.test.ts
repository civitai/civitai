import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE DRIFTED ON-SITE LISTING — one fixture, five gates, both directions.
 *
 * `AppListing.userId` is the CANONICAL owner for an OFF-SITE listing and a DENORMALIZED
 * COPY for an ON-SITE one, whose real owner is `OauthClient.userId` reached as
 * `AppListing.appBlock.app.userId`. The copy can go stale: `acceptTransfer`'s onsite
 * step 3 is deliberately unguarded and treats a 0-count as an accepted desync. Five
 * production gates used to compare the caller against that copy, and on a drifted row a
 * comparison like that fails in BOTH directions at once:
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
 * 🔴 MEASURED STATE, so the stakes are stated honestly: 0 drifted rows across all 21
 * onsite listings in production on 2026-08-11, because the only mechanism that creates
 * drift (an onsite ownership transfer) has never run. This is LATENT, not live. It goes
 * live on the first onsite transfer.
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

  it('still admits an ACCEPTED editor and a moderator, and still refuses a stranger', async () => {
    seatFor(EDITOR);
    await expect(getListingAssets({ listingId: LIVE }, user(EDITOR))).resolves.toMatchObject({
      listingId: LIVE,
    });
    // The mod bypass (D1) is this file's alone and must survive the consolidation — and
    // it must still short-circuit BEFORE the resolve, so a mod pays no seat lookup.
    await expect(
      getListingAssets({ listingId: LIVE }, { id: STRANGER, isModerator: true } as never)
    ).resolves.toMatchObject({ listingId: LIVE });
    await expect(getListingAssets({ listingId: LIVE }, user(STRANGER))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
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

  it('🔴 RECORDED DISAGREEMENT (not an endorsement): offsite + a block ⇒ the BLOCK wins', async () => {
    // 🔴 This pins what the shared resolver DOES today, and it is NOT what its own prose
    // says. `resolveListingAccess` computes `appBlock.app.userId ?? listing.userId` —
    // BLOCK-FIRST, with no branch on `kind`. That reads as "kind-aware" only because an
    // ordinary off-site listing has no block, so the fallback is the only branch reached.
    //
    // On the one shape where the two rules differ — an OFFSITE listing that carries a
    // block, which `mapAppBlockToListing` mints from any AppBlock with an `externalUrl`
    // and which the mod proc `backfillAppListings` can reach — the block wins, so the
    // listing's own `userId` does NOT decide. That matters because
    // `app-ownership-transfer` moves ONLY the column for an offsite listing: transfer
    // such a listing and this resolver keeps naming the OLD owner. It is the same
    // stale-copy inversion, one shape over.
    //
    // 0 rows of this shape in production (measured 2026-08-11: 5 offsite listings, 0 with
    // a block), and `resolveAccessibleAppBlockIds` already discriminates on `kind` rather
    // than on block-nullness for exactly this reason — so the two halves of one module
    // disagree about which discriminator is authoritative. Changing the resolver is a
    // decision for whoever owns that call, not a side effect of consolidating five gates,
    // so it is RECORDED here (and in the ledger's D5 note) and pinned, not silently
    // altered. This test failing means someone changed it — read this comment first.
    wireListings({
      [LIVE]: offsite({ appBlockId: BLOCK, appBlock: { app: { userId: STRANGER } } }),
    });
    await expect(getListingAssets({ listingId: LIVE }, user(STRANGER))).resolves.toMatchObject({
      listingId: LIVE,
    });
    await expect(getListingAssets({ listingId: LIVE }, user(REAL_OWNER))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
