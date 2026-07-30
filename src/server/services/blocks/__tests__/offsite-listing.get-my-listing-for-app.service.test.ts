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
 * Route `appListing.findUnique` by call shape:
 *   - `where.appBlockId`   → the entry resolve (id/userId/status/contentRating)
 *   - `select` has `icon`  → `loadListingEditView`, keyed by `where.id`
 *   - otherwise            → the owner/editable load (`beginListingRevision`)
 */
function wireFindUnique(opts: {
  entry: unknown;
  owned?: unknown;
  viewByListingId?: Record<string, unknown>;
}) {
  mockRead.appListing.findUnique.mockImplementation(async (args: unknown) => {
    const a = args as {
      select?: Record<string, unknown>;
      where?: { id?: string; appBlockId?: string };
    };
    if (a.where?.appBlockId != null) return opts.entry;
    if ('icon' in (a.select ?? {})) return opts.viewByListingId?.[a.where?.id ?? ''] ?? null;
    return opts.owned ?? null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seq.n = 0;
  mockRead.appListing.findUnique.mockResolvedValue(null);
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
    // And the edit-view read targeted the shadow, not the parent.
    expect(mockRead.appListing.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'apl_shadow' },
        select: expect.objectContaining({ icon: expect.anything() }),
      })
    );
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
  });
});
