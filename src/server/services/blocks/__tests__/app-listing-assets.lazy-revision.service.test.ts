import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LAZY shadow-revision minting on the owner asset procs — Part 1 of the
 * listing-revision staleness fix.
 *
 * `getMyListingForApp` no longer calls `beginListingRevision`: opening the media tab
 * used to CREATE a `draft` `AppListing`. Measured on prod 2026-07-30 — 7 shadows,
 * 7/7 with `updated_at == created_at` (never written since their clone tx), 6 minted
 * that day by page views alone, three of them 1.5 s apart from opening three apps in
 * a row; 78% of approved onsite parents carried a shadow that represented no edit,
 * and they refilled the instant anyone looked again. So the shadow is minted here, by
 * the first asset MUTATION.
 *
 * 🔴 THE HAZARD THIS SUITE EXISTS FOR. `removeScreenshot` / `reorderScreenshots` /
 * `updateScreenshotCaption` take `AppListingScreenshot` ROW ids, and until a shadow
 * exists the ids the client holds are the LIVE PARENT's rows. Applied naively, a
 * "remove screenshot" would DELETE A ROW OFF THE SERVED LISTING with no moderator
 * review — the exact data-loss path the 🔴 SECURITY note on
 * `GetMyListingForAppResult.assets` warns about. The write path therefore mints the
 * shadow and RE-KEYS the row id onto the fresh clone before touching anything, and
 * `assertOwnerAssetEditable` runs on the RESOLVED target as fail-closed defence in
 * depth.
 *
 * The DB is an in-memory FAKE rather than call-shape stubs, deliberately: the
 * assertion that matters is "the PARENT's rows are still there afterwards", and only
 * a store that actually holds rows can make that claim honestly. One store backs both
 * pools, so the REAL `beginListingRevision` clone runs against it.
 *
 * 🔴 `dbRead` and `dbWrite` are DISTINCT fakes over that store (`readDb` / `db`), with
 * a `store.replicaLagsOn` set the REPLICA cannot see. They used to be the same object,
 * which made every "this read must go to the PRIMARY" claim in the service
 * unfalsifiable — a guard nothing could break is a guard nothing verifies.
 */

type ListingRow = {
  id: string;
  kind: string;
  slug: string;
  status: string;
  userId: number;
  revisionOfId: string | null;
  appBlockId: string | null;
  name: string;
  tagline: string | null;
  description: string | null;
  category: string | null;
  contentRating: string | null;
  externalUrl: string | null;
  connectClientId: string | null;
  connectRequestedScopes: number | null;
  connectScopeJustifications: unknown;
  iconId: number | null;
  coverId: number | null;
};

type ShotRow = {
  id: string;
  appListingId: string;
  imageId: number | null;
  order: number;
  caption: string | null;
};

type ImageRow = {
  id: number;
  userId: number;
  type: string;
  width: number;
  height: number;
  mimeType: string;
  metadata: { size: number };
  ingestion: string;
  nsfwLevel: number;
};

const { store, db, readDb, ids } = vi.hoisted(() => {
  const store = {
    listings: [] as ListingRow[],
    shots: [] as ShotRow[],
    images: [] as ImageRow[],
    /**
     * 🔴 REPLICA LAG. Ids (listing OR screenshot row) the REPLICA has not received
     * yet. `dbRead` below hides them; `dbWrite` still serves them — i.e. exactly the
     * read-after-write condition that decides whether a just-minted shadow's rows are
     * reachable. Without a `dbRead` that can differ from `dbWrite` the pool routing is
     * structurally untestable, which is why the two used to be the SAME fake and this
     * whole class of bug (#3476) could not be pinned here.
     */
    replicaLagsOn: new Set<string>(),
  };
  const ids = { n: 0 };

  const matchListing = (row: ListingRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v);

  const appListing = {
    findUnique: vi.fn(async (args: { where: Record<string, unknown> }) => {
      return store.listings.find((l) => matchListing(l, args.where)) ?? null;
    }),
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
      return store.listings.find((l) => matchListing(l, args.where)) ?? null;
    }),
    create: vi.fn(async (args: { data: Partial<ListingRow> }) => {
      const row = { ...(args.data as ListingRow) };
      store.listings.push(row);
      return row;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Partial<ListingRow> }) => {
      const row = store.listings.find((l) => l.id === args.where.id);
      if (!row) throw new Error(`no listing ${args.where.id}`);
      Object.assign(row, args.data);
      return row;
    }),
    findMany: vi.fn(async () => [] as ListingRow[]),
  };

  const appListingScreenshot = {
    findUnique: vi.fn(async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
      const row = store.shots.find((s) => s.id === args.where.id);
      if (!row) return null;
      // Hydrate the `appListing` relation when selected (the row-id-keyed procs use it
      // for the ownership check).
      if (args.select && 'appListing' in args.select) {
        const listing = store.listings.find((l) => l.id === row.appListingId) ?? null;
        return { ...row, appListing: listing };
      }
      return row;
    }),
    findMany: vi.fn(
      async (args: {
        where: { appListingId?: string; imageId?: unknown };
        orderBy?: { order?: 'asc' | 'desc' };
      }) => {
        let rows = store.shots.filter((s) => s.appListingId === args.where.appListingId);
        if (args.orderBy?.order === 'desc') rows = [...rows].sort((a, b) => b.order - a.order);
        else rows = [...rows].sort((a, b) => a.order - b.order);
        return rows.map((r) => ({ ...r }));
      }
    ),
    count: vi.fn(
      async (args: { where: { appListingId?: string } }) =>
        store.shots.filter((s) => s.appListingId === args.where.appListingId).length
    ),
    create: vi.fn(async (args: { data: ShotRow }) => {
      store.shots.push({ ...args.data });
      return args.data;
    }),
    createMany: vi.fn(async (args: { data: ShotRow[] }) => {
      for (const d of args.data) store.shots.push({ ...d });
      return { count: args.data.length };
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Partial<ShotRow> }) => {
      const row = store.shots.find((s) => s.id === args.where.id);
      if (!row) throw new Error(`no screenshot ${args.where.id}`);
      Object.assign(row, args.data);
      return row;
    }),
    delete: vi.fn(async (args: { where: { id: string } }) => {
      const i = store.shots.findIndex((s) => s.id === args.where.id);
      if (i < 0) throw new Error(`no screenshot ${args.where.id}`);
      return store.shots.splice(i, 1)[0];
    }),
    // The LISTING-SCOPED write forms. A compound `{ id, appListingId }` filter is the
    // whole point: it must match ZERO rows once `applyApprovedRevision` has reparented
    // the shadow's rows onto the live parent.
    updateMany: vi.fn(
      async (args: { where: { id?: string; appListingId?: string }; data: Partial<ShotRow> }) => {
        const rows = store.shots.filter(
          (s) =>
            (args.where.id === undefined || s.id === args.where.id) &&
            (args.where.appListingId === undefined || s.appListingId === args.where.appListingId)
        );
        for (const r of rows) Object.assign(r, args.data);
        return { count: rows.length };
      }
    ),
    deleteMany: vi.fn(async (args: { where: { id?: string; appListingId?: string } }) => {
      const keep: ShotRow[] = [];
      let count = 0;
      for (const s of store.shots) {
        const hit =
          (args.where.id === undefined || s.id === args.where.id) &&
          (args.where.appListingId === undefined || s.appListingId === args.where.appListingId);
        if (hit) count += 1;
        else keep.push(s);
      }
      store.shots = keep;
      return { count };
    }),
  };

  const image = {
    findUnique: vi.fn(async (args: { where: { id: number } }) => {
      return store.images.find((i) => i.id === args.where.id) ?? null;
    }),
    findMany: vi.fn(async (args: { where: { id: { in: number[] } } }) =>
      store.images.filter((i) => args.where.id.in.includes(i.id))
    ),
  };

  const db = {
    appListing,
    appListingScreenshot,
    image,
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(db);
      return Promise.all(arg as Promise<unknown>[]);
    }),
  };

  /**
   * The REPLICA. Same store, but rows in `store.replicaLagsOn` are invisible —
   * replication has not caught up. Only the READ surface is modelled; every write in
   * the service goes through `dbWrite` by construction, and a write landing here would
   * be a bug worth failing on.
   */
  const lagging = (id: string) => store.replicaLagsOn.has(id);
  const readDb = {
    appListing: {
      findUnique: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const row = store.listings.find((l) => matchListing(l, args.where));
        return row && !lagging(row.id) ? row : null;
      }),
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const row = store.listings.find((l) => matchListing(l, args.where));
        return row && !lagging(row.id) ? row : null;
      }),
      findMany: vi.fn(async () => [] as ListingRow[]),
    },
    appListingScreenshot: {
      findUnique: vi.fn(
        async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
          const row = store.shots.find((s) => s.id === args.where.id);
          if (!row || lagging(row.id) || lagging(row.appListingId)) return null;
          if (args.select && 'appListing' in args.select) {
            const listing = store.listings.find((l) => l.id === row.appListingId) ?? null;
            return { ...row, appListing: listing };
          }
          return row;
        }
      ),
      findMany: vi.fn(
        async (args: {
          where: { appListingId?: string };
          orderBy?: { order?: 'asc' | 'desc' };
        }) => {
          let rows = store.shots.filter(
            (s) => s.appListingId === args.where.appListingId && !lagging(s.id)
          );
          if (args.orderBy?.order === 'desc') rows = [...rows].sort((a, b) => b.order - a.order);
          else rows = [...rows].sort((a, b) => a.order - b.order);
          return rows.map((r) => ({ ...r }));
        }
      ),
      count: vi.fn(
        async (args: { where: { appListingId?: string } }) =>
          store.shots.filter((s) => s.appListingId === args.where.appListingId && !lagging(s.id))
            .length
      ),
    },
    image,
  };

  return { store, db, readDb, ids };
});

// 🔴 dbRead and dbWrite are DISTINCT fakes over one store. They used to be the same
// object, which silently made every "reads the primary" claim in this module
// unfalsifiable.
vi.mock('~/server/db/client', () => ({ dbRead: readDb, dbWrite: db }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_gen_${++ids.n}`,
  newAppListingPublishRequestId: () => `alpr_gen_${++ids.n}`,
  newAppListingScreenshotId: () => `apls_gen_${++ids.n}`,
  newUlid: () => `ULID${++ids.n}`,
}));

import {
  addListingScreenshot,
  matchClonedScreenshotRow,
  removeListingScreenshot,
  reorderListingScreenshots,
  setListingCover,
  setListingIcon,
  updateListingScreenshotCaption,
} from '~/server/services/blocks/app-listing-assets.service';

const OWNER = { id: 42, isModerator: false } as never;
const MOD = { id: 7, isModerator: true } as never;

const PARENT_ID = 'apl_parent';

function listing(overrides: Partial<ListingRow> = {}): ListingRow {
  return {
    id: PARENT_ID,
    kind: 'onsite',
    slug: 'my-app',
    status: 'approved',
    userId: 42,
    revisionOfId: null,
    appBlockId: 'ab_1',
    name: 'My App',
    tagline: null,
    description: null,
    category: null,
    contentRating: 'pg13',
    externalUrl: null,
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    iconId: 100,
    coverId: 101,
    ...overrides,
  };
}

/**
 * A clean, scan-complete image the owner owns (so attach always succeeds). Square by
 * default (valid icon/screenshot); `landscape` gives a 16:9 that clears the cover
 * aspect gate (1.3–2.4).
 */
function seedImage(id: number, opts: { userId?: number; landscape?: boolean } = {}) {
  store.images.push({
    id,
    userId: opts.userId ?? 42,
    type: 'image',
    width: opts.landscape ? 1920 : 1024,
    height: opts.landscape ? 1080 : 1024,
    mimeType: 'image/png',
    metadata: { size: 50_000 },
    ingestion: 'Scanned',
    nsfwLevel: 1,
  });
}

function seedShot(id: string, appListingId: string, imageId: number, order: number) {
  store.shots.push({ id, appListingId, imageId, order, caption: null });
}

/** The shadow of PARENT_ID, if the code under test minted one. */
const shadow = () => store.listings.find((l) => l.revisionOfId === PARENT_ID) ?? null;
const shotsOf = (listingId: string) =>
  store.shots.filter((s) => s.appListingId === listingId).sort((a, b) => a.order - b.order);

beforeEach(() => {
  vi.clearAllMocks();
  ids.n = 0;
  store.listings = [];
  store.shots = [];
  store.images = [];
  store.replicaLagsOn = new Set();
});

// ---------------------------------------------------------------------------
// Mint on first edit — icon / cover / add-screenshot (id-safe: they carry an
// imageId + a target listing id, so there is nothing to re-map).
// ---------------------------------------------------------------------------

describe('lazy shadow minting — the first asset mutation opens the revision', () => {
  it('🔴 setIcon on a live approved listing mints the shadow and writes to IT, never the parent', async () => {
    store.listings.push(listing());
    seedImage(200);

    const res = await setListingIcon({ listingId: PARENT_ID, imageId: 200 }, OWNER);

    expect(res).toMatchObject({ status: 'attached', iconId: 200 });
    const sh = shadow();
    expect(sh).not.toBeNull();
    expect(sh!.status).toBe('draft');
    // The revision carries the new icon…
    expect(sh!.iconId).toBe(200);
    // …and the LIVE listing is byte-identical to what it was. This is the whole point.
    expect(store.listings.find((l) => l.id === PARENT_ID)!.iconId).toBe(100);
  });

  it('setCover likewise stages on the shadow', async () => {
    store.listings.push(listing());
    seedImage(201, { landscape: true });

    await setListingCover({ listingId: PARENT_ID, imageId: 201 }, OWNER);

    expect(shadow()!.coverId).toBe(201);
    expect(store.listings.find((l) => l.id === PARENT_ID)!.coverId).toBe(101);
  });

  it('🔴 addScreenshot appends to the SHADOW — the live listing’s set is untouched', async () => {
    store.listings.push(listing());
    seedShot('apls_parent_a', PARENT_ID, 300, 0);
    seedImage(301);

    await addListingScreenshot({ listingId: PARENT_ID, imageId: 301 }, OWNER);

    // The clone copied the parent's one screenshot; the add landed on top of it.
    expect(shotsOf(shadow()!.id).map((s) => s.imageId)).toEqual([300, 301]);
    // The live listing still has exactly its original row, same id, same order.
    expect(shotsOf(PARENT_ID)).toEqual([
      { id: 'apls_parent_a', appListingId: PARENT_ID, imageId: 300, order: 0, caption: null },
    ]);
  });

  it('reuses an EXISTING shadow — never a second one (the UNIQUE index on revision_of_id holds)', async () => {
    store.listings.push(listing());
    store.listings.push(
      listing({
        id: 'apl_existing',
        status: 'draft',
        revisionOfId: PARENT_ID,
        appBlockId: null,
        slug: 'rev-x',
        iconId: 555,
      })
    );
    seedImage(202);

    await setListingIcon({ listingId: PARENT_ID, imageId: 202 }, OWNER);

    expect(store.listings.filter((l) => l.revisionOfId === PARENT_ID).map((l) => l.id)).toEqual([
      'apl_existing',
    ]);
    expect(db.appListing.create).not.toHaveBeenCalled();
    // The owner's in-progress edits are preserved — the reused shadow just took the
    // new icon; nothing re-cloned over it.
    expect(shadow()!.iconId).toBe(202);
  });

  it('a shadow itself is edited in place (no revision of a revision)', async () => {
    store.listings.push(listing());
    const sh = listing({
      id: 'apl_shadow',
      status: 'draft',
      revisionOfId: PARENT_ID,
      appBlockId: null,
      slug: 'rev-x',
    });
    store.listings.push(sh);
    seedImage(203);

    await setListingIcon({ listingId: 'apl_shadow', imageId: 203 }, OWNER);

    expect(store.listings.filter((l) => l.revisionOfId === 'apl_shadow')).toHaveLength(0);
    expect(sh.iconId).toBe(203);
  });

  it.each(['draft', 'pending'])(
    'an in-place editable (%s) listing is edited DIRECTLY — no shadow, unchanged behaviour',
    async (status) => {
      store.listings.push(listing({ status }));
      seedImage(204);

      await setListingIcon({ listingId: PARENT_ID, imageId: 204 }, OWNER);

      expect(shadow()).toBeNull();
      expect(db.appListing.create).not.toHaveBeenCalled();
      expect(store.listings.find((l) => l.id === PARENT_ID)!.iconId).toBe(204);
    }
  );

  it('a MODERATOR still curates the LIVE listing directly (the documented bypass)', async () => {
    store.listings.push(listing());
    seedImage(205, { userId: 7 });

    await setListingIcon({ listingId: PARENT_ID, imageId: 205 }, MOD);

    expect(shadow()).toBeNull();
    expect(store.listings.find((l) => l.id === PARENT_ID)!.iconId).toBe(205);
  });
});

// ---------------------------------------------------------------------------
// 🔴 THE ROW-ID HAZARD. These three procs are keyed on AppListingScreenshot.id.
// ---------------------------------------------------------------------------

describe('🔴 screenshot ROW-ID re-map — a parent row id must never mutate the live listing', () => {
  beforeEach(() => {
    store.listings.push(listing());
    seedShot('apls_parent_a', PARENT_ID, 300, 0);
    seedShot('apls_parent_b', PARENT_ID, 301, 1);
  });

  it('🔴 removeScreenshot with a PARENT row id deletes from the SHADOW, leaving the live rows intact', async () => {
    const res = await removeListingScreenshot({ screenshotId: 'apls_parent_a' }, OWNER);

    // 🔴 THE ASSERTION. Without the re-map this deletes a screenshot off the listing
    // that is currently being served, with no moderator review — the exact data-loss
    // path the security note on `getMyListingForApp.assets` describes.
    expect(shotsOf(PARENT_ID).map((s) => s.id)).toEqual(['apls_parent_a', 'apls_parent_b']);
    // It removed the CORRESPONDING row on the revision instead (matched by imageId).
    const sh = shadow();
    expect(sh).not.toBeNull();
    expect(shotsOf(sh!.id).map((s) => s.imageId)).toEqual([301]);
    // …and it reports the row it actually removed, not the id it was handed.
    expect(res.removed).not.toBe('apls_parent_a');
    // Survivors are re-packed to contiguous 0..n-1 on the SHADOW.
    expect(shotsOf(sh!.id).map((s) => s.order)).toEqual([0]);
  });

  it('🔴 updateScreenshotCaption with a PARENT row id re-captions the SHADOW’s clone', async () => {
    await updateListingScreenshotCaption(
      { screenshotId: 'apls_parent_b', caption: 'staged caption' },
      OWNER
    );

    expect(store.shots.find((s) => s.id === 'apls_parent_b')!.caption).toBeNull();
    const staged = shotsOf(shadow()!.id).find((s) => s.imageId === 301);
    expect(staged!.caption).toBe('staged caption');
  });

  it('🔴 reorderScreenshots with PARENT row ids reorders the SHADOW’s clones', async () => {
    const res = await reorderListingScreenshots(
      { listingId: PARENT_ID, orderedIds: ['apls_parent_b', 'apls_parent_a'] },
      OWNER
    );

    expect(res.reordered).toBe(2);
    // Live order unchanged.
    expect(shotsOf(PARENT_ID).map((s) => s.imageId)).toEqual([300, 301]);
    // Revision order swapped.
    expect(shotsOf(shadow()!.id).map((s) => s.imageId)).toEqual([301, 300]);
  });

  it('an UNMAPPABLE row id is REFUSED (fail-closed), and nothing is deleted anywhere', async () => {
    // A row on the parent whose image the clone can't reproduce: delete the parent row
    // AFTER the client read it, so the re-map source lookup misses.
    store.shots = store.shots.filter((s) => s.id !== 'apls_parent_a');
    store.shots.push({
      id: 'apls_orphan',
      appListingId: PARENT_ID,
      imageId: null,
      order: 5,
      caption: null,
    });
    // Two null-image rows on the parent → the clone produces two indistinguishable
    // candidates, so `matchClonedScreenshotRow` refuses rather than guessing.
    store.shots.push({
      id: 'apls_orphan2',
      appListingId: PARENT_ID,
      imageId: null,
      order: 6,
      caption: null,
    });
    store.shots.find((s) => s.id === 'apls_orphan')!.order = 6;

    await expect(
      removeListingScreenshot({ screenshotId: 'apls_orphan' }, OWNER)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // The live listing kept every row.
    expect(shotsOf(PARENT_ID)).toHaveLength(3);
  });

  it('once the shadow exists, the client’s SHADOW row ids pass straight through (no re-map)', async () => {
    // Mint it via a first edit, then act on the ids the client now holds.
    seedImage(400);
    await setListingIcon({ listingId: PARENT_ID, imageId: 400 }, OWNER);
    const sh = shadow()!;
    const target = shotsOf(sh.id)[0];

    const res = await removeListingScreenshot({ screenshotId: target.id }, OWNER);

    expect(res.removed).toBe(target.id);
    expect(shotsOf(sh.id).map((s) => s.imageId)).toEqual([301]);
    expect(shotsOf(PARENT_ID)).toHaveLength(2);
  });

  it('a MODERATOR’s row-id remove still hits the LIVE row (curation bypass preserved)', async () => {
    await removeListingScreenshot({ screenshotId: 'apls_parent_a' }, MOD);

    expect(shadow()).toBeNull();
    expect(shotsOf(PARENT_ID).map((s) => s.id)).toEqual(['apls_parent_b']);
  });
});

// ---------------------------------------------------------------------------
// The pure matcher, in isolation.
// ---------------------------------------------------------------------------

describe('matchClonedScreenshotRow', () => {
  const rows = [
    { id: 's1', imageId: 10, order: 0 },
    { id: 's2', imageId: 11, order: 1 },
  ];

  it('matches an exact (imageId, order) pair — the fresh-clone case', () => {
    expect(matchClonedScreenshotRow({ imageId: 11, order: 1 }, rows)).toBe('s2');
  });

  it('falls back to a UNIQUE imageId when the target was reordered', () => {
    expect(matchClonedScreenshotRow({ imageId: 11, order: 5 }, rows)).toBe('s2');
  });

  it('refuses an AMBIGUOUS match (same image attached twice) rather than guessing', () => {
    const dupes = [
      { id: 's1', imageId: 10, order: 0 },
      { id: 's2', imageId: 10, order: 1 },
    ];
    expect(matchClonedScreenshotRow({ imageId: 10, order: 7 }, dupes)).toBeNull();
  });

  it('refuses when the image is absent from the target', () => {
    expect(matchClonedScreenshotRow({ imageId: 99, order: 0 }, rows)).toBeNull();
  });

  it('refuses a null-image row that has no unique (null, order) partner', () => {
    const nulls = [
      { id: 's1', imageId: null, order: 0 },
      { id: 's2', imageId: null, order: 1 },
    ];
    expect(matchClonedScreenshotRow({ imageId: null, order: 9 }, nulls)).toBeNull();
    // …but an exact (null, order) pair is unambiguous and DOES match.
    expect(matchClonedScreenshotRow({ imageId: null, order: 1 }, nulls)).toBe('s2');
  });
});

// ---------------------------------------------------------------------------
// 🔴 READ-AFTER-WRITE on the row-id-keyed procs.
//
// The client now receives freshly-minted SHADOW row ids sourced from the PRIMARY
// (`getMyListingForApp` probes `dbWrite` for the shadow). `resolveOwnerScreenshotTarget`
// then read the screenshot row AND its listing off the REPLICA, so under replication
// lag the owner's second edit 404'd on a row that demonstrably exists — the same class
// of bug #3476 fixed for `loadListingEditView`, whose window this change widened by
// moving the mint onto the write path.
// ---------------------------------------------------------------------------

/** A live parent + its shadow revision, cloned rows and all. */
function seedShadowWithClonedRows() {
  store.listings.push(listing());
  store.listings.push(
    listing({
      id: 'apl_shadow',
      status: 'draft',
      revisionOfId: PARENT_ID,
      appBlockId: null,
      slug: 'rev-x',
    })
  );
  seedShot('apls_parent_a', PARENT_ID, 300, 0);
  seedShot('apls_parent_b', PARENT_ID, 301, 1);
  seedShot('apls_shadow_a', 'apl_shadow', 300, 0);
  seedShot('apls_shadow_b', 'apl_shadow', 301, 1);
}

/**
 * What `applyApprovedRevision` does to the screenshot rows: drop the parent's set,
 * then REPARENT the shadow's rows onto the parent (`updateMany appListingId →
 * parentId`). After this, a row id resolved a moment ago as a SHADOW row is a row on
 * the LIVE listing.
 */
function simulateApprovalReparent(shadowId: string) {
  store.shots = store.shots.filter((s) => s.appListingId !== PARENT_ID);
  for (const s of store.shots) if (s.appListingId === shadowId) s.appListingId = PARENT_ID;
}

describe('replica lag — a shadow row id must not 404 on the pool that cannot see it yet', () => {
  it('🔴 removeScreenshot resolves a JUST-MINTED shadow row the replica has not received', () => {
    seedShadowWithClonedRows();
    // Replication has not caught up on the shadow listing or its cloned rows.
    store.replicaLagsOn = new Set(['apl_shadow', 'apls_shadow_a', 'apls_shadow_b']);

    return removeListingScreenshot({ screenshotId: 'apls_shadow_a' }, OWNER).then((res) => {
      expect(res).toEqual({ removed: 'apls_shadow_a' });
      // It came off the SHADOW…
      expect(shotsOf('apl_shadow').map((s) => s.id)).toEqual(['apls_shadow_b']);
      // …and the live listing is untouched.
      expect(shotsOf(PARENT_ID).map((s) => s.id)).toEqual(['apls_parent_a', 'apls_parent_b']);
    });
  });

  it('🔴 updateScreenshotCaption likewise — neither the row read nor the listing read may trust the replica', async () => {
    seedShadowWithClonedRows();
    store.replicaLagsOn = new Set(['apl_shadow', 'apls_shadow_a', 'apls_shadow_b']);

    await updateListingScreenshotCaption(
      { screenshotId: 'apls_shadow_b', caption: 'staged on the revision' },
      OWNER
    );

    expect(store.shots.find((s) => s.id === 'apls_shadow_b')!.caption).toBe(
      'staged on the revision'
    );
    // The live row that shares the image keeps its own caption.
    expect(store.shots.find((s) => s.id === 'apls_parent_b')!.caption).toBeNull();
  });

  it('a row that exists on NEITHER pool is still a genuine NOT_FOUND', async () => {
    seedShadowWithClonedRows();
    await expect(removeListingScreenshot({ screenshotId: 'apls_nope' }, OWNER)).rejects.toThrow(
      /Screenshot not found/
    );
  });
});

// ---------------------------------------------------------------------------
// 🔴 LISTING-SCOPED WRITES.
//
// `applyApprovedRevision` REPARENTS the shadow's screenshot rows onto the live parent.
// A moderator approving between the resolve and the write turns a resolved SHADOW row
// id into a PARENT row id — and the writes were `delete({ where: { id } })` /
// `update({ where: { id } })`, i.e. they would have landed on the LIVE served listing.
// Scoping every write to `{ id, appListingId: <resolved listing> }` and requiring
// `count === 1` makes that structurally impossible rather than merely improbable.
// ---------------------------------------------------------------------------

describe('the reparent race — a resolved row id that became a LIVE row must not be written', () => {
  it('🔴 removeScreenshot refuses instead of deleting off the live listing', async () => {
    seedShadowWithClonedRows();
    // Approve lands right after the ownership/target resolve reads the listing.
    vi.mocked(readDb.appListing.findUnique).mockImplementationOnce(async (args: unknown) => {
      const id = (args as { where: { id?: string } }).where.id;
      const row = store.listings.find((l) => l.id === id) ?? null;
      simulateApprovalReparent('apl_shadow');
      return row;
    });

    await expect(removeListingScreenshot({ screenshotId: 'apls_shadow_a' }, OWNER)).rejects.toThrow(
      /no longer available on your revision/
    );

    // The row survived — it is now a LIVE screenshot and nothing deleted it.
    expect(shotsOf(PARENT_ID).map((s) => s.id)).toEqual(['apls_shadow_a', 'apls_shadow_b']);
  });

  it('🔴 updateScreenshotCaption refuses instead of re-captioning a live row', async () => {
    seedShadowWithClonedRows();
    vi.mocked(readDb.appListing.findUnique).mockImplementationOnce(async (args: unknown) => {
      const id = (args as { where: { id?: string } }).where.id;
      const row = store.listings.find((l) => l.id === id) ?? null;
      simulateApprovalReparent('apl_shadow');
      return row;
    });

    await expect(
      updateListingScreenshotCaption({ screenshotId: 'apls_shadow_a', caption: 'oops' }, OWNER)
    ).rejects.toThrow(/no longer available on your revision/);

    expect(store.shots.find((s) => s.id === 'apls_shadow_a')!.caption).toBeNull();
  });

  it('🔴 reorderScreenshots refuses instead of re-ordering the live listing', async () => {
    seedShadowWithClonedRows();
    // The approve lands AFTER the permutation check's primary read — the only window
    // in which the scoped write is the thing that saves the live listing.
    vi.mocked(db.appListingScreenshot.findMany).mockImplementationOnce(async (args: unknown) => {
      const where = (args as { where: { appListingId?: string } }).where;
      const rows = store.shots
        .filter((s) => s.appListingId === where.appListingId)
        .map((r) => ({ ...r }));
      simulateApprovalReparent('apl_shadow');
      return rows;
    });

    await expect(
      reorderListingScreenshots(
        { listingId: 'apl_shadow', orderedIds: ['apls_shadow_b', 'apls_shadow_a'] },
        OWNER
      )
    ).rejects.toThrow(/no longer available on your revision/);

    // The now-live rows kept their original order — the reorder did not land.
    expect(shotsOf(PARENT_ID).map((s) => [s.id, s.order])).toEqual([
      ['apls_shadow_a', 0],
      ['apls_shadow_b', 1],
    ]);
  });

  it('the ordinary (unraced) reorder still works and writes exactly the resolved listing', async () => {
    seedShadowWithClonedRows();
    const res = await reorderListingScreenshots(
      { listingId: 'apl_shadow', orderedIds: ['apls_shadow_b', 'apls_shadow_a'] },
      OWNER
    );
    expect(res).toEqual({ reordered: 2 });
    expect(shotsOf('apl_shadow').map((s) => s.id)).toEqual(['apls_shadow_b', 'apls_shadow_a']);
    // The live listing's ordering is untouched.
    expect(shotsOf(PARENT_ID).map((s) => [s.id, s.order])).toEqual([
      ['apls_parent_a', 0],
      ['apls_parent_b', 1],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Return-shape contract (FIX 5): these two procs answer with the row they actually
// WROTE, which is NOT the id the caller passed when this call minted the shadow.
// ---------------------------------------------------------------------------

describe('row-id-keyed procs return the RESOLVED row id, not an echo of the input', () => {
  it('🔴 removeScreenshot reports the SHADOW clone it deleted, not the parent id it was given', async () => {
    store.listings.push(listing());
    seedShot('apls_parent_a', PARENT_ID, 300, 0);

    const res = await removeListingScreenshot({ screenshotId: 'apls_parent_a' }, OWNER);

    // Deliberate: echoing back `apls_parent_a` would report deleting a row off the
    // LIVE listing — a deletion that must never happen and here did not.
    expect(res.removed).not.toBe('apls_parent_a');
    expect(shotsOf(PARENT_ID).map((s) => s.id)).toEqual(['apls_parent_a']);
    expect(shotsOf(shadow()!.id)).toEqual([]);
  });

  it('🔴 updateScreenshotCaption reports the SHADOW clone it wrote', async () => {
    store.listings.push(listing());
    seedShot('apls_parent_a', PARENT_ID, 300, 0);

    const res = await updateListingScreenshotCaption(
      { screenshotId: 'apls_parent_a', caption: 'hello' },
      OWNER
    );

    expect(res.id).not.toBe('apls_parent_a');
    expect(store.shots.find((s) => s.id === res.id)!.appListingId).toBe(shadow()!.id);
    expect(store.shots.find((s) => s.id === 'apls_parent_a')!.caption).toBeNull();
  });
});
