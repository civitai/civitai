import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `listMyAppListings` — the SCAN dimension of the completeness advisory
 * (`blocked-media` / `scanning-media`), and the batching that makes it affordable.
 *
 * 🔴 WHY THIS FILE EXISTS. `computeListingProblems` has emitted eight codes since the
 * scan dimension landed, but two of them — `blocked-media` (BLOCKING) and
 * `scanning-media` — could never appear on `/apps/mine` or in the CLI, because
 * `hydrateMyAppListings` called it with no `assetScans`. Both sides were green in
 * isolation: the pure function's own suite covers all eight codes exhaustively, and this
 * service's suite covered the six that were wired. Nothing tested the SEAM, so "two codes
 * are structurally unreachable on the only surface that renders them" was invisible.
 * The lesson is the general one: ask which surface your fixture does NOT load.
 *
 * 🔴 EVERY CASE HERE IS A POSITIVE CONTROL FIRST. A reassuring zero — "no scan problems"
 * — is exactly what the DEFECT produced, so an assertion that the codes are absent proves
 * nothing on its own. Each case below drives the number UP from a fixture that would have
 * produced zero at `origin/main`, and the sibling "all Scanned ⇒ none" case is the
 * negative control that keeps the wiring from being a constant.
 *
 * 🔴 `dbRead` AND `dbWrite` ARE DISTINCT (the canonical `dbMock` keeps them so). This file
 * family has twice been bitten by aliasing them, which makes a replica/primary bug
 * structurally undetectable — and this feature has a real choice in that axis: the
 * single-listing poll (`getAssetScanStatuses`) reads the PRIMARY for promptness, while
 * this LIST read must not. The last case in the batching block asserts the primary is
 * never touched, which an aliased mock could not express.
 */

const mockDb = dbMock.dbRead;
const mockWriteDb = dbMock.dbWrite;

const { listMyAppListings } = await import('~/server/services/blocks/app-access.service');

const OWNER = 11;

/** Ingestion literals, spelled out so a fixture cannot borrow the implementation's enum. */
const SCANNED = 'Scanned';
const BLOCKED = 'Blocked';
const PENDING = 'Pending';

type Stored = {
  id: string;
  iconId: number | null;
  coverId: number | null;
  description: string | null;
  tagline: string | null;
  category: string | null;
  _count: { screenshots: number };
  slug: string;
  name: string;
  status: string;
  kind: string;
  appBlockId: string | null;
  updatedAt: Date;
  icon: { url: string | null } | null;
  cover: { url: string | null } | null;
  columnUserId: number;
};

/**
 * A COMPLETE listing by default — every non-scan problem already satisfied.
 *
 * 🔴 That is deliberate and load-bearing: it means any code this file's assertions see is
 * a SCAN code, so `toEqual([...])` on the whole list can be exact rather than a
 * `toContain` that would pass while the rest of the advisory silently broke.
 *
 * The asset ids are PAIRWISE DISTINCT (icon 7, cover 9, screenshots 31/32) so an operand
 * swap between the icon and cover slots changes the ANSWER, not merely the argument — and
 * distinct from the screenshot count (3) so no assertion's expected value can be produced
 * by reading the wrong field.
 */
function stored(over: Partial<Stored> & { id: string }): Stored {
  return {
    slug: `slug-${over.id}`,
    name: `Name ${over.id}`,
    status: 'approved',
    kind: 'offsite',
    appBlockId: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    icon: { url: 'icon-uuid' },
    cover: { url: 'cover-uuid' },
    iconId: 7,
    coverId: 9,
    description: `Description of ${over.id}`,
    tagline: `Tagline of ${over.id}`,
    category: 'utility',
    _count: { screenshots: 3 },
    columnUserId: OWNER,
    ...over,
  };
}

/** `appListing.findMany` fake — honours `select`, and evaluates the ownership probe. */
function findManyFake(table: Stored[]) {
  return async (...a: unknown[]): Promise<unknown[]> => {
    const args = (a[0] ?? {}) as {
      where?: { OR?: Array<Record<string, unknown>>; id?: { in: string[] } };
      take?: number;
      select?: Record<string, unknown>;
    };
    const where = args.where ?? {};
    let rows = table;
    if (where.id?.in) rows = rows.filter((r) => where.id!.in.includes(r.id));
    if (where.OR) {
      const userId = ((): number | undefined => {
        for (const branch of where.OR) if (typeof branch.userId === 'number') return branch.userId;
        return undefined;
      })();
      rows = rows.filter((r) => r.columnUserId === userId);
    }
    const select = args.select;
    return rows.slice(0, args.take ?? rows.length).map((r) => {
      if (!select) return { ...r };
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(select)) {
        if (select[key]) out[key] = (r as unknown as Record<string, unknown>)[key];
      }
      return out;
    });
  };
}

/**
 * A screenshot-row fake that HONOURS the `appListingId: { in: [...] }` predicate.
 *
 * 🔴 A fake that returned every row regardless of the `where` could not tell "the batch
 * asks for this page's listings" from "the batch asks for nothing and the grouping puts
 * the rows back by luck". Honouring the filter is what makes the cross-listing
 * attribution case below a real assertion.
 */
function screenshotFake(rows: { appListingId: string; imageId: number | null }[]) {
  return async (...a: unknown[]): Promise<unknown[]> => {
    const args = (a[0] ?? {}) as {
      where?: { appListingId?: { in: string[] }; imageId?: { not: null } };
    };
    const ids = args.where?.appListingId?.in;
    let out = rows;
    if (ids) out = out.filter((r) => ids.includes(r.appListingId));
    if (args.where?.imageId) out = out.filter((r) => r.imageId != null);
    return out.map((r) => ({ ...r }));
  };
}

/** An `image.findMany` fake that honours `id: { in: [...] }`. */
function imageFake(images: { id: number; ingestion: string | null }[]) {
  return async (...a: unknown[]): Promise<unknown[]> => {
    const args = (a[0] ?? {}) as { where?: { id?: { in: number[] } } };
    const ids = args.where?.id?.in;
    return (ids ? images.filter((i) => ids.includes(i.id)) : images).map((i) => ({ ...i }));
  };
}

/** Codes on the row with this id, in emitted order. */
async function codesFor(id: string): Promise<string[]> {
  const rows = await listMyAppListings({ userId: OWNER });
  const row = rows.find((r) => r.appListingId === id);
  expect(row, `no row for ${id}`).toBeDefined();
  return row!.problems.map((p) => p.code);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.appListing.findMany.mockImplementation(async () => []);
  mockDb.appCollaborator.findMany.mockImplementation(async () => []);
  mockDb.appListingScreenshot.findMany.mockImplementation(async () => []);
  mockDb.image.findMany.mockImplementation(async () => []);
});

describe('🔴 listMyAppListings — the SCAN codes actually reach a row', () => {
  /**
   * 🔴 THE NEGATIVE CONTROL, FIRST. Everything attached and `Scanned` ⇒ the advisory is
   * empty. Without this, an implementation that emitted `blocked-media` unconditionally
   * would pass every positive case below.
   */
  it('an all-Scanned listing reports NO problems at all', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([stored({ id: 'apl_clean' })]));
    mockDb.appListingScreenshot.findMany.mockImplementation(
      screenshotFake([{ appListingId: 'apl_clean', imageId: 31 }])
    );
    mockDb.image.findMany.mockImplementation(
      imageFake([
        { id: 7, ingestion: SCANNED },
        { id: 9, ingestion: SCANNED },
        { id: 31, ingestion: SCANNED },
      ])
    );
    expect(await codesFor('apl_clean')).toEqual([]);
  });

  /**
   * 🔴 THE HEADLINE POSITIVE CONTROL — the count MOVES, 0 → 1, on a listing that at
   * `origin/main` reported zero problems while being unable to publish. `blocked-media` is
   * a BLOCKING code: `assertAssetsScanClean` would refuse the go-live, and until this
   * wiring nothing told the author why.
   */
  it('🔴 a BLOCKED icon surfaces blocked-media (blocking) — the number moves from zero', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([stored({ id: 'apl_blk' })]));
    mockDb.image.findMany.mockImplementation(
      imageFake([
        { id: 7, ingestion: BLOCKED },
        { id: 9, ingestion: SCANNED },
      ])
    );
    const rows = await listMyAppListings({ userId: OWNER });
    expect(rows[0].problems.map((p) => p.code)).toEqual(['blocked-media']);
    expect(rows[0].problems[0].severity).toBe('blocking');
    // The label names the SLOT, so the author knows which asset to replace. Asserting it
    // pins that `kind` is threaded through the batch rather than defaulted.
    expect(rows[0].problems[0].label).toContain('icon');
  });

  it('🔴 a PENDING cover surfaces scanning-media (advisory)', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([stored({ id: 'apl_pend' })]));
    mockDb.image.findMany.mockImplementation(
      imageFake([
        { id: 7, ingestion: SCANNED },
        { id: 9, ingestion: PENDING },
      ])
    );
    const rows = await listMyAppListings({ userId: OWNER });
    expect(rows[0].problems.map((p) => p.code)).toEqual(['scanning-media']);
    expect(rows[0].problems[0].severity).toBe('advisory');
    expect(rows[0].problems[0].label.toLowerCase()).toContain('cover');
  });

  /**
   * 🔴 SCREENSHOTS ARE THE HALF THAT NEEDS THE EXTRA QUERY. icon/cover ids are already on
   * the hydrate row; screenshot image ids are not, so a wiring that only threaded
   * icon/cover would pass both cases above and still be blind here.
   */
  it('🔴 a BLOCKED SCREENSHOT surfaces blocked-media — the ids come from the batched screenshot read', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([stored({ id: 'apl_shot' })]));
    mockDb.appListingScreenshot.findMany.mockImplementation(
      screenshotFake([
        { appListingId: 'apl_shot', imageId: 31 },
        { appListingId: 'apl_shot', imageId: 32 },
      ])
    );
    mockDb.image.findMany.mockImplementation(
      imageFake([
        { id: 7, ingestion: SCANNED },
        { id: 9, ingestion: SCANNED },
        { id: 31, ingestion: BLOCKED },
        { id: 32, ingestion: SCANNED },
      ])
    );
    const codes = await codesFor('apl_shot');
    expect(codes).toEqual(['blocked-media']);
  });

  /**
   * Two blocked screenshots on one listing ⇒ ONE problem (the pure function dedupes by
   * KIND). Asserted here rather than only in the pure suite because the batch is what
   * decides how many entries of the same kind it emits — an implementation that
   * accidentally deduped by IMAGE ID upstream would look identical on a single-blocked
   * fixture.
   */
  it('two blocked screenshots collapse to ONE blocked-media', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([stored({ id: 'apl_two' })]));
    mockDb.appListingScreenshot.findMany.mockImplementation(
      screenshotFake([
        { appListingId: 'apl_two', imageId: 31 },
        { appListingId: 'apl_two', imageId: 32 },
      ])
    );
    mockDb.image.findMany.mockImplementation(
      imageFake([
        { id: 7, ingestion: SCANNED },
        { id: 9, ingestion: SCANNED },
        { id: 31, ingestion: BLOCKED },
        { id: 32, ingestion: BLOCKED },
      ])
    );
    expect(await codesFor('apl_two')).toEqual(['blocked-media']);
  });

  /**
   * 🔴 A DELETED Image ROW MUST NOT INVENT A PROBLEM. `AppListingScreenshot.imageId` is
   * `onDelete: SetNull` and an icon/cover FK can outlive its Image, so "no row came back"
   * is an ordinary state — and the tempting reading (absent ⇒ still scanning, which is
   * what the go-live gate assumes) would latch `scanning-media` on a listing FOREVER, with
   * no asset the author could replace to clear it.
   */
  it('🔴 an asset whose Image row is GONE contributes no scan problem', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([stored({ id: 'apl_ghost' })]));
    // Icon 7 and cover 9 are attached; the Image table returns NEITHER.
    mockDb.image.findMany.mockImplementation(imageFake([]));
    expect(await codesFor('apl_ghost')).toEqual([]);
  });

  /**
   * 🔴 PER-LISTING ATTRIBUTION. The whole page's asset ids go into ONE `image.findMany`,
   * so the grouping back onto rows is hand-written code that can be wrong — and the way it
   * is wrong is that every listing inherits every other listing's problems. Two listings
   * with DISJOINT asset ids, one poisoned, is the fixture that can see it.
   */
  it('🔴 a blocked asset lands on ITS OWN listing and no other', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([
        stored({ id: 'apl_sick', iconId: 101, coverId: 102 }),
        stored({ id: 'apl_well', iconId: 201, coverId: 202 }),
      ])
    );
    mockDb.appListingScreenshot.findMany.mockImplementation(
      screenshotFake([
        { appListingId: 'apl_sick', imageId: 103 },
        { appListingId: 'apl_well', imageId: 203 },
      ])
    );
    mockDb.image.findMany.mockImplementation(
      imageFake([
        { id: 101, ingestion: BLOCKED },
        { id: 102, ingestion: SCANNED },
        { id: 103, ingestion: SCANNED },
        { id: 201, ingestion: SCANNED },
        { id: 202, ingestion: SCANNED },
        { id: 203, ingestion: SCANNED },
      ])
    );
    const rows = await listMyAppListings({ userId: OWNER });
    const byId = Object.fromEntries(rows.map((r) => [r.appListingId, r.problems.map((p) => p.code)]));
    expect(byId.apl_sick).toEqual(['blocked-media']);
    expect(byId.apl_well).toEqual([]);
  });

  /**
   * The six pre-existing codes must still fire alongside the two new ones, and in the
   * documented order (assets → text → blocked → pending). A regression here would mean the
   * scan wiring displaced the advisory rather than extending it.
   */
  it('the scan codes are APPENDED to the existing advisory, not substituted for it', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([
        stored({ id: 'apl_mix', coverId: null, tagline: null, _count: { screenshots: 0 } }),
      ])
    );
    mockDb.image.findMany.mockImplementation(imageFake([{ id: 7, ingestion: BLOCKED }]));
    expect(await codesFor('apl_mix')).toEqual([
      'missing-cover',
      'no-screenshots',
      'empty-tagline',
      'blocked-media',
    ]);
  });
});

describe('🔴 listMyAppListings — the scan read is BATCHED, not a per-row fan-out', () => {
  /**
   * 🔴 THE COST GUARD, and the reason this feature was left unwired for so long. Driving
   * `getListingAssets` per row would be 2N queries on a page of N listings — a list read
   * turning into a fan-out. THREE listings must still produce exactly ONE screenshot query
   * and ONE image query.
   *
   * The fixture uses three listings precisely so a per-row implementation reports 3, which
   * `toHaveBeenCalledTimes(1)` sees. A one-listing fixture could not tell the two apart.
   */
  it('🔴 three listings ⇒ ONE screenshot query and ONE image query', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([
        stored({ id: 'apl_a', iconId: 1, coverId: 2 }),
        stored({ id: 'apl_b', iconId: 3, coverId: 4 }),
        stored({ id: 'apl_c', iconId: 5, coverId: 6 }),
      ])
    );
    mockDb.appListingScreenshot.findMany.mockImplementation(
      screenshotFake([
        { appListingId: 'apl_a', imageId: 11 },
        { appListingId: 'apl_b', imageId: 12 },
        { appListingId: 'apl_c', imageId: 13 },
      ])
    );
    mockDb.image.findMany.mockImplementation(
      imageFake([1, 2, 3, 4, 5, 6, 11, 12, 13].map((id) => ({ id, ingestion: SCANNED })))
    );

    await listMyAppListings({ userId: OWNER });
    expect(mockDb.appListingScreenshot.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.image.findMany).toHaveBeenCalledTimes(1);
  });

  /** …and the ONE image query really does carry every listing's ids, not just the first. */
  it('the single image query asks for every asset id on the page', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([
        stored({ id: 'apl_a', iconId: 1, coverId: 2 }),
        stored({ id: 'apl_b', iconId: 3, coverId: 4 }),
      ])
    );
    mockDb.appListingScreenshot.findMany.mockImplementation(
      screenshotFake([{ appListingId: 'apl_b', imageId: 12 }])
    );
    mockDb.image.findMany.mockImplementation(
      imageFake([1, 2, 3, 4, 12].map((id) => ({ id, ingestion: SCANNED })))
    );

    await listMyAppListings({ userId: OWNER });
    const call = mockDb.image.findMany.mock.calls.at(-1)?.[0] as { where: { id: { in: number[] } } };
    expect([...call.where.id.in].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 12]);
  });

  /**
   * 🔴 THE REPLICA/PRIMARY AXIS. `getAssetScanStatuses` reads `dbWrite` on purpose — it
   * backs a poll the author watches tick over. This list read must NOT: a page-sized
   * `IN (…)` against the primary is exactly the traffic the replica exists to absorb, and
   * a few seconds of lag on "still scanning" is invisible on a dashboard. An aliased
   * read/write mock could not express this assertion at all.
   */
  it('🔴 reads the REPLICA — the primary is never touched', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([stored({ id: 'apl_r' })]));
    mockDb.image.findMany.mockImplementation(imageFake([{ id: 7, ingestion: SCANNED }]));
    await listMyAppListings({ userId: OWNER });
    expect(mockDb.image.findMany).toHaveBeenCalled();
    expect(mockWriteDb.image.findMany).not.toHaveBeenCalled();
    expect(mockWriteDb.appListingScreenshot.findMany).not.toHaveBeenCalled();
  });

  /**
   * The screenshot read is filtered to live Images IN THE DATABASE, not in memory — the
   * same `imageId: { not: null }` predicate the `_count` and the authoritative asset gate
   * use. Pinned structurally because the behavioural consequence (a null-image screenshot
   * contributes nothing) is indistinguishable from the in-memory guard that also exists.
   */
  it('the screenshot read filters `imageId: { not: null }` in the query', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([stored({ id: 'apl_f' })]));
    await listMyAppListings({ userId: OWNER });
    const call = mockDb.appListingScreenshot.findMany.mock.calls.at(-1)?.[0] as {
      where: { imageId?: unknown; appListingId?: { in: string[] } };
      select: Record<string, unknown>;
    };
    expect(call.where.imageId).toEqual({ not: null });
    expect(call.where.appListingId).toEqual({ in: ['apl_f'] });
    // Only the two columns the grouping needs — never the caption/order payload.
    expect(Object.keys(call.select).sort()).toEqual(['appListingId', 'imageId']);
  });

  /**
   * An empty accessible set must not issue either batched query. This is the same
   * `.length` short-circuit discipline the moderation-event read already keeps, and it is
   * what stops the common "author with nothing yet" case from paying for the feature.
   */
  it('an author with no listings issues NEITHER batched query', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([]));
    expect(await listMyAppListings({ userId: 999 })).toEqual([]);
    expect(mockDb.appListingScreenshot.findMany).not.toHaveBeenCalled();
    expect(mockDb.image.findMany).not.toHaveBeenCalled();
  });

  /**
   * A page whose listings have NO attached assets at all skips the Image query — there is
   * nothing to look up. The screenshot query still runs (it is what proves there are no
   * screenshots), so this pins the SECOND short-circuit specifically.
   */
  it('a page with no attached assets skips the image query but still asks for screenshots', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([stored({ id: 'apl_bare', iconId: null, coverId: null })])
    );
    await listMyAppListings({ userId: OWNER });
    expect(mockDb.appListingScreenshot.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.image.findMany).not.toHaveBeenCalled();
  });
});
