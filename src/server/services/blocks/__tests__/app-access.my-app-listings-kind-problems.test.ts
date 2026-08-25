import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `listMyAppListings` (`appListings.listMine`) — THE KIND SEAM of the completeness
 * advisory.
 *
 * 🔴 WHY THIS FILE EXISTS, AND WHY THE PURE SUITE IS NOT ENOUGH. `computeListingProblems`
 * now branches on `kind`, and `listing-problems.kind.test.ts` covers that branch
 * exhaustively — as a PURE function, against a fixture that hands it `kind` directly.
 * None of that says the SERVICE actually threads the row's kind into it. This is the
 * `isolation-seam` shape that already bit this exact file family once: the pure suite and
 * the service suite were each green while two of the eight codes were structurally
 * unreachable, because nothing built the combined state. A `kind` the service never
 * passes would leave `/apps/mine` — the ONLY surface this advisory renders on — showing
 * the off-site advice for every on-site listing, with both suites green.
 *
 * 🔴 `listMine` RETURNS BOTH KINDS ON ONE PAGE, so this is not a per-caller constant that
 * could be hardcoded: the same response can carry an on-site row and an off-site row, and
 * they must disagree about the remedy. The cases below put both on one page and assert
 * they diverge — an implementation that passed a literal kind, or read the wrong row's
 * kind, fails here and cannot fail anywhere else.
 *
 * 🔴 EVERY CASE IS PAIRED, and the OFF-SITE row is the POSITIVE CONTROL. An on-site-only
 * assertion would also pass against an implementation that gave BOTH kinds the manifest
 * label. The `findMany` fake HONOURS `select`, so a service that stops projecting `kind`
 * gets `undefined` here — which the implementation degrades to the off-site labels, so
 * the on-site expectations go red. That is the intended detection route for a dropped
 * projection.
 *
 * 🔴 `dbRead` AND `dbWrite` ARE DISTINCT (the canonical `dbMock` keeps them so) — this
 * family has twice been bitten by aliasing them. This LIST read must never touch the
 * primary, and the last case says so.
 *
 * 🔴 WHICH CASES ARE REGRESSION COVERAGE. Measured at `origin/main` 4bfd4c16d: 2 of the
 * 7 cases here go RED — "an ON-SITE row names block.manifest.json" and "BOTH KINDS ON ONE
 * PAGE diverge". The other 5 PASS at base and are INVARIANT GUARDS, NOT coverage of this
 * bug. Two of them earn their place a different way: `listMine` ALREADY selected `kind`
 * at base (it feeds `capabilitiesForKind`), so "the service PROJECTS `kind`" can never
 * have been red — it exists to stop that projection being removed as dead weight, which
 * is the route by which this fix would silently revert. Likewise the off-site positive
 * control is green at base by construction; its job is to kill a mutant that gives BOTH
 * kinds the manifest label (M9 in the sweep), which no on-site assertion can do.
 */

const mockDb = dbMock.dbRead;
const mockWriteDb = dbMock.dbWrite;

const { listMyAppListings } = await import('~/server/services/blocks/app-access.service');

const OWNER = 11;

/** The EXACT pre-change labels — what an OFF-SITE row must still produce. */
const ORIGINAL_LABEL = {
  'empty-description': 'Missing description',
  'empty-tagline': 'Missing tagline',
  'empty-category': 'Missing category',
} as const;

/** The ON-SITE labels, spelled out rather than imported from the implementation. */
const MANIFEST_LABEL = {
  'empty-description':
    'Missing description — set "description" in block.manifest.json and resubmit',
  'empty-tagline': 'Missing tagline — set "tagline" in block.manifest.json and resubmit',
  'empty-category':
    'Missing category — resubmit to apply it; set "category" in block.manifest.json first if your app has none',
} as const;

type Stored = {
  id: string;
  slug: string;
  name: string;
  status: string;
  kind: string;
  appBlockId: string | null;
  updatedAt: Date;
  icon: { url: string | null } | null;
  cover: { url: string | null } | null;
  iconId: number | null;
  coverId: number | null;
  description: string | null;
  tagline: string | null;
  category: string | null;
  _count: { screenshots: number };
  columnUserId: number;
};

/**
 * A listing whose ASSETS are all present and whose TEXT is all EMPTY.
 *
 * 🔴 That is the inverse of the scan-suite's fixture and is deliberate: it means every
 * code these assertions see is a TEXT code, so `toEqual([...])` on the whole list can be
 * exact rather than a `toContain` that would pass while the rest of the advisory broke.
 *
 * Asset ids are PAIRWISE DISTINCT (icon 41, cover 53) and distinct from the screenshot
 * count (7), so an operand swap between adjacent arguments changes the ANSWER rather than
 * merely the argument, and no assertion's expected value can be produced by reading the
 * wrong field. `kind` has NO default — every caller below states it, so a fixture cannot
 * quietly inherit one arm.
 */
function stored(over: Partial<Stored> & { id: string; kind: string }): Stored {
  return {
    slug: `slug-${over.id}`,
    name: `Name ${over.id}`,
    status: 'approved',
    appBlockId: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    icon: { url: 'icon-uuid' },
    cover: { url: 'cover-uuid' },
    iconId: 41,
    coverId: 53,
    description: null,
    tagline: null,
    category: null,
    _count: { screenshots: 7 },
    columnUserId: OWNER,
    ...over,
  };
}

/** `appListing.findMany` fake — HONOURS `select`, and evaluates the ownership probe. */
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

/** The problem list on the row with this id, as `code → label`. */
async function labelsFor(id: string): Promise<Record<string, string>> {
  const rows = await listMyAppListings({ userId: OWNER });
  const row = rows.find((r) => r.appListingId === id);
  expect(row, `no row for ${id}`).toBeDefined();
  return Object.fromEntries(row!.problems.map((p) => [p.code, p.label]));
}

beforeEach(() => {
  // 🔴 EXPLICIT, not relied upon: `no-direct-shared-module-mock` registers `dbMock`
  // globally and its reset is per-FILE, not per-test, so "called once" arms would
  // accumulate across cases in this file without this.
  vi.clearAllMocks();
  mockDb.appListing.findMany.mockImplementation(async () => []);
  mockDb.appCollaborator.findMany.mockImplementation(async () => []);
  mockDb.appListingScreenshot.findMany.mockImplementation(async () => []);
  mockDb.image.findMany.mockImplementation(async () => []);
});

describe('🔴 listMyAppListings — the row KIND reaches the advisory', () => {
  /**
   * 🔴 THE FIXTURE GUARD. Both rows must declare a kind, and they must DIFFER — a page
   * where both rows are the same kind cannot distinguish "the service threads each row's
   * own kind" from "the service passes one constant".
   */
  const onsiteRow = stored({ id: 'l-on', kind: 'onsite' });
  const offsiteRow = stored({ id: 'l-off', kind: 'offsite' });

  it('🔴 fixture guard — the two rows declare DIFFERENT, known kinds', () => {
    for (const r of [onsiteRow, offsiteRow]) {
      expect(Object.prototype.hasOwnProperty.call(r, 'kind')).toBe(true);
      expect(['onsite', 'offsite']).toContain(r.kind);
    }
    expect(onsiteRow.kind).not.toBe(offsiteRow.kind);
  });

  it('an ON-SITE row names block.manifest.json for all three text problems', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([onsiteRow]));
    const labels = await labelsFor('l-on');
    expect(labels['empty-description']).toBe(MANIFEST_LABEL['empty-description']);
    expect(labels['empty-tagline']).toBe(MANIFEST_LABEL['empty-tagline']);
    expect(labels['empty-category']).toBe(MANIFEST_LABEL['empty-category']);
  });

  it('POSITIVE CONTROL — an OFF-SITE row still produces the ORIGINAL labels, verbatim', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([offsiteRow]));
    const labels = await labelsFor('l-off');
    expect(labels['empty-description']).toBe(ORIGINAL_LABEL['empty-description']);
    expect(labels['empty-tagline']).toBe(ORIGINAL_LABEL['empty-tagline']);
    expect(labels['empty-category']).toBe(ORIGINAL_LABEL['empty-category']);
  });

  it("🔴 BOTH KINDS ON ONE PAGE diverge — the service reads EACH row's own kind, not a constant", async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([onsiteRow, offsiteRow]));
    const rows = await listMyAppListings({ userId: OWNER });

    // Positive control on the page itself: both rows are present and both carry
    // problems, so "they differ" is not a comparison of two empty lists.
    expect(rows.map((r) => r.appListingId).sort()).toEqual(['l-off', 'l-on']);
    const byId = Object.fromEntries(
      rows.map((r) => [
        r.appListingId,
        Object.fromEntries(r.problems.map((p) => [p.code, p.label])),
      ])
    );
    expect(Object.keys(byId['l-on'])).toEqual([
      'empty-description',
      'empty-tagline',
      'empty-category',
    ]);
    expect(Object.keys(byId['l-off'])).toEqual([
      'empty-description',
      'empty-tagline',
      'empty-category',
    ]);

    for (const code of ['empty-description', 'empty-tagline', 'empty-category'] as const) {
      expect(byId['l-on'][code]).toBe(MANIFEST_LABEL[code]);
      expect(byId['l-off'][code]).toBe(ORIGINAL_LABEL[code]);
      expect(byId['l-on'][code]).not.toBe(byId['l-off'][code]);
    }
  });

  it('the CODES are identical across the two rows (wire contract — a released CLI branches on `code`)', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([onsiteRow, offsiteRow]));
    const rows = await listMyAppListings({ userId: OWNER });
    const codesOf = (id: string) =>
      rows.find((r) => r.appListingId === id)!.problems.map((p) => p.code);
    // Against a LITERAL, not against each other — comparing the two arms would pass if
    // both were equally wrong.
    const expected = ['empty-description', 'empty-tagline', 'empty-category'];
    expect(codesOf('l-on')).toEqual(expected);
    expect(codesOf('l-off')).toEqual(expected);
  });

  it('the service PROJECTS `kind` (a dropped projection is what would silently revert this)', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([onsiteRow]));
    await listMyAppListings({ userId: OWNER });
    const hydrateCall = mockDb.appListing.findMany.mock.calls.find(
      (c) => (c[0] as { select?: Record<string, unknown> })?.select?.description
    );
    expect(hydrateCall, 'no hydrate call selecting the advisory fields').toBeDefined();
    expect((hydrateCall![0] as { select: Record<string, unknown> }).select.kind).toBe(true);
  });

  it('reads the REPLICA only — the primary is never touched', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([onsiteRow, offsiteRow]));
    await listMyAppListings({ userId: OWNER });
    expect(mockWriteDb.appListing.findMany).not.toHaveBeenCalled();
  });
});
