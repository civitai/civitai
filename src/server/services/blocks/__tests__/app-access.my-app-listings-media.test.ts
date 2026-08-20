import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `listMyAppListings` — the MEDIA widening, and the ownership∪seat set it must not disturb.
 *
 * 🔴 WHY THIS FILE EXISTS AT ALL. The merged `/apps/mine` table shows an icon and a cover
 * per row, and `app_listings.icon_id` / `cover_id` are integer FKs to `Image` — not URLs.
 * So "show the images" is a SERVER change: the select has to reach `Image.url` and the row
 * has to carry a CDN URL. That widening touches the one read that answers "which apps may
 * I act on", which is the single most load-bearing property of the consolidation, so the
 * three populations that read depends on are re-asserted here ALONGSIDE the new fields
 * rather than in a separate file where they could drift apart.
 *
 * 🔴 THE THREE POPULATIONS ARE THE POINT. `/apps/my-submissions` was scoped to a publish
 * request's `submittedByUserId`, and a naive merge onto that read silently loses:
 *   (1) the accepted COLLABORATOR — submitted nothing, so every row is someone else's;
 *   (2) the TRANSFER recipient — the request keeps the original submitter's id forever;
 *   (3) the MODERATOR-CLAIMED owner — same mechanism as (2).
 * (2) and (3) are indistinguishable at this seam by construction: both are "I own the
 * listing and did not submit it", which is exactly the shape `submittedByUserId` cannot
 * see and `resolveAccessibleListingIds` resolves correctly. Both are fixtured.
 *
 */

/**
 * 🔴 THE DB IS MOCKED THROUGH THE CANONICAL SHARED MOCK, not a per-file
 * per-file mock of the db-client specifier. Under `isolate: false` a per-file mock freezes
 * that one file's mock shape into every LATER file in the same worker — a file that mocks
 * nothing at all then fails on a missing export. `src/__tests__/setup.ts` registers `dbMock` once
 * for every file and resets it between them, and
 * `src/server/services/__tests__/no-direct-shared-module-mock.test.ts` fails on any new
 * direct mock of a guarded specifier — it caught this file. That guard is a TEXT scan, so
 * the call it forbids cannot even be quoted in this comment.
 */
const mockDb = dbMock.dbRead;
const mockWriteDb = dbMock.dbWrite;
void mockWriteDb;

const { listMyAppListings } = await import('~/server/services/blocks/app-access.service');

/** Distinct ids so no assertion's expected value can be produced by the wrong branch. */
const OWNER = 11;
const SEAT_HOLDER = 22;

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
  /** `OauthClient.userId` reached via the block. `null` = no block. */
  blockOwnerUserId: number | null;
  /** The denormalized column. */
  columnUserId: number;
};

function stored(over: Partial<Stored> & { id: string }): Stored {
  return {
    slug: `slug-${over.id}`,
    name: `Name ${over.id}`,
    status: 'approved',
    kind: 'onsite',
    appBlockId: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    icon: null,
    cover: null,
    // 🔴 PAIRWISE-DISTINCT SIBLING VALUES, deliberately. `iconId` and `coverId` are two
    // ints feeding two adjacent arguments of `computeListingProblems`; if they shared a
    // value (or were both null by default) an OPERAND SWAP — passing `r.iconId` where
    // `coverId` belongs — would produce identical output and survive a green suite. 7 and
    // 9 are distinct from each other and from the screenshot count.
    iconId: 7,
    coverId: 9,
    description: `Description of ${over.id}`,
    tagline: `Tagline of ${over.id}`,
    category: 'utility',
    _count: { screenshots: 3 },
    blockOwnerUserId: null,
    columnUserId: OWNER,
    ...over,
  };
}

/**
 * A fake `appListing.findMany` that HONOURS `select`.
 *
 * 🔴 That is the whole instrument. A fake that returns canned columns regardless of the
 * query cannot distinguish "the select asks for the icon relation" from "it does not", so
 * a mutant deleting `icon: { select: { url: true } }` from the real select would survive a
 * fully green run. Here, projecting only what was asked for means the assertion on
 * `iconUrl` is genuinely an assertion about the SELECT.
 */
function findManyFake(table: Stored[]) {
  return async (...a: unknown[]): Promise<unknown[]> => {
    const args = (a[0] ?? {}) as {
      where?: { revisionOfId?: null; OR?: Array<Record<string, unknown>>; id?: { in: string[] } };
      take?: number;
      select?: Record<string, unknown>;
    };
    const where = args.where ?? {};
    let rows = table;
    if (where.id?.in) rows = rows.filter((r) => where.id!.in.includes(r.id));
    if (where.OR) {
      // The ownership probe. Kind-aware, written from the spec rather than copied from the
      // implementation: onsite ⇒ the block's OauthClient owner (falling back to the column
      // when there is no block); anything else ⇒ the column.
      const userId = ((): number | undefined => {
        for (const branch of where.OR) {
          const block = branch.appBlock as { app?: { userId?: number } } | null | undefined;
          if (block?.app?.userId != null) return block.app.userId;
          if (typeof branch.userId === 'number') return branch.userId;
        }
        return undefined;
      })();
      rows = rows.filter((r) =>
        r.kind === 'onsite' && r.blockOwnerUserId != null
          ? r.blockOwnerUserId === userId
          : r.columnUserId === userId
      );
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

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.appListing.findMany.mockImplementation(async () => []);
  mockDb.appCollaborator.findMany.mockImplementation(async () => []);
});

describe('listMyAppListings — media on the wire', () => {
  it('🔴 projects icon_id/cover_id through to CDN URLs, not raw ids', async () => {
    const table = [
      stored({
        id: 'apl_media',
        kind: 'offsite',
        status: 'draft',
        columnUserId: OWNER,
        icon: { url: 'icon-uuid-1' },
        cover: { url: 'cover-uuid-1' },
      }),
    ];
    mockDb.appListing.findMany.mockImplementation(findManyFake(table));

    const rows = await listMyAppListings({ userId: OWNER });
    expect(rows).toHaveLength(1);
    // The exact CDN shape belongs to `getEdgeUrl`; what this pins is that the URL is
    // DERIVED from the Image row rather than the FK being echoed back or dropped.
    expect(rows[0].iconUrl).toEqual(expect.stringContaining('icon-uuid-1'));
    expect(rows[0].coverUrl).toEqual(expect.stringContaining('cover-uuid-1'));
    expect(rows[0].iconUrl).not.toBe('icon-uuid-1');
  });

  /**
   * 🔴 THE PLACEHOLDER PATH IS THE MAIN PATH FOR THE INACTIVE TABLE. Measured on
   * production 2026-08-19: all 11 `removed` listings have `cover_id IS NULL` (10 of 11 do
   * have an icon). So `coverUrl === null` on a removed row is the ordinary case, and the
   * server must say `null` — not omit the key, and not substitute something.
   */
  it('🔴 a removed listing with an icon but NO cover reports coverUrl null', async () => {
    const table = [
      stored({
        id: 'apl_removed',
        status: 'removed',
        columnUserId: OWNER,
        icon: { url: 'icon-uuid-2' },
        cover: null,
      }),
    ];
    mockDb.appListing.findMany.mockImplementation(findManyFake(table));

    const rows = await listMyAppListings({ userId: OWNER });
    expect(rows[0].iconUrl).toEqual(expect.stringContaining('icon-uuid-2'));
    expect(rows[0].coverUrl).toBeNull();
    expect('coverUrl' in rows[0]).toBe(true);
  });

  /**
   * 🔴 NO SCREENSHOT FALLBACK ON THIS READ, unlike the public store card. A missing cover
   * is the fact its author needs to see, and the advisory "no cover" warning already tells
   * them so — a silent screenshot substitution here would make the table contradict the
   * warning. Pinned by asserting the read never even asks for screenshots.
   */
  it('🔴 does not join screenshots — the author sees the real gap', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([stored({ id: 'apl_x', columnUserId: OWNER })])
    );
    await listMyAppListings({ userId: OWNER });
    const hydrateCall = mockDb.appListing.findMany.mock.calls.at(-1)?.[0] as {
      select?: Record<string, unknown>;
    };
    expect(hydrateCall.select).toBeDefined();
    expect(hydrateCall.select).toHaveProperty('icon');
    expect(hydrateCall.select).toHaveProperty('cover');
    expect(hydrateCall.select).not.toHaveProperty('screenshots');
  });

  it('carries updatedAt so the table can order by "recently updated"', async () => {
    const when = new Date('2026-06-15T08:30:00Z');
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([stored({ id: 'apl_when', columnUserId: OWNER, updatedAt: when })])
    );
    const rows = await listMyAppListings({ userId: OWNER });
    expect(rows[0].updatedAt).toEqual(when);
  });
});

describe('🔴 listMyAppListings — the ownership∪seat set is UNCHANGED by the widening', () => {
  /**
   * All three populations in ONE call, because the failure mode is a set, not a row: a
   * merge onto the submissions read returns a STRICT SUBSET, and only comparing the whole
   * set to the expectation can see that.
   */
  it('returns the owned, the seated, the transferred and the mod-claimed app together', async () => {
    const table = [
      // (1) plain ownership, on-site, via the block's OauthClient.
      stored({
        id: 'apl_owned',
        kind: 'onsite',
        status: 'approved',
        appBlockId: 'ab_owned',
        blockOwnerUserId: SEAT_HOLDER,
        columnUserId: SEAT_HOLDER,
        icon: { url: 'icon-owned' },
      }),
      // (2) an ACCEPTED SEAT on someone else's app — the caller submitted nothing here.
      stored({
        id: 'apl_seated',
        kind: 'offsite',
        status: 'pending',
        columnUserId: OWNER,
        cover: { url: 'cover-seated' },
      }),
      // (3) acquired by TRANSFER: the column names the caller, the app's whole publish
      // history names someone else.
      stored({
        id: 'apl_transferred',
        kind: 'offsite',
        status: 'draft',
        columnUserId: SEAT_HOLDER,
      }),
      // (4) acquired by moderator CLAIM: same seam, on-site, the block's owner moved.
      stored({
        id: 'apl_claimed',
        kind: 'onsite',
        status: 'removed',
        appBlockId: 'ab_claimed',
        blockOwnerUserId: SEAT_HOLDER,
        columnUserId: OWNER,
      }),
      // A control the caller must NOT see: owned by someone else, no seat.
      stored({ id: 'apl_stranger', kind: 'offsite', status: 'rejected', columnUserId: OWNER }),
    ];
    mockDb.appListing.findMany.mockImplementation(findManyFake(table));
    mockDb.appCollaborator.findMany.mockImplementation(async () => [
      { appListingId: 'apl_seated' },
    ]);

    const rows = await listMyAppListings({ userId: SEAT_HOLDER });
    expect(rows.map((r) => r.appListingId).sort()).toEqual([
      'apl_claimed',
      'apl_owned',
      'apl_seated',
      'apl_transferred',
    ]);
    // The seat row is tagged `editor`; everything resolved by ownership is `owner`.
    const roleById = Object.fromEntries(rows.map((r) => [r.appListingId, r.role]));
    expect(roleById).toEqual({
      apl_owned: 'owner',
      apl_transferred: 'owner',
      apl_claimed: 'owner',
      apl_seated: 'editor',
    });
    // …and the media widening reaches EVERY population, not just the owned one.
    for (const r of rows) {
      expect(r).toHaveProperty('iconUrl');
      expect(r).toHaveProperty('coverUrl');
    }
    expect(roleById.apl_seated).toBe('editor');
    expect(rows.find((r) => r.appListingId === 'apl_seated')?.coverUrl).toEqual(
      expect.stringContaining('cover-seated')
    );
  });

  it('a caller with neither ownership nor a seat still gets nothing', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([stored({ id: 'apl_other', columnUserId: OWNER })])
    );
    expect(await listMyAppListings({ userId: 999 })).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * 🔴 THE `problems` SEAM
 * ------------------------------------------------------------------------ */

/**
 * 🔴 THIS BLOCK EXISTS BECAUSE BOTH SIDES WERE ALREADY GREEN IN ISOLATION.
 * `computeListingProblems` is well covered as a pure function, and the CLIENT test hands
 * `problems` in by hand — so nothing exercised the JOIN between them. An independently
 * built mutation sweep found three survivors right here: `problems` forced to `[]` (which
 * is the missing-advisory defect restored, silently), `coverId` fed from `r.iconId`, and
 * the screenshot-count default flipped `0 → 99`. Every one passed a fully green suite.
 *
 * The fixtures below carry pairwise-distinct sibling values so an operand swap changes the
 * ANSWER and not merely the arguments.
 */
describe('🔴 listMyAppListings — the completeness advisory is wired to the row', () => {
  it('a fully complete listing reports NO problems', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([stored({ id: 'apl_ok', columnUserId: OWNER })])
    );
    const rows = await listMyAppListings({ userId: OWNER });
    expect(rows[0].problems).toEqual([]);
  });

  /**
   * 🔴 KILLS "`problems` is always `[]`". A constant-empty implementation passes the
   * complete-listing case above by construction, so THIS is the assertion that can see it.
   */
  it('🔴 a listing missing its ICON reports missing-icon', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([stored({ id: 'apl_noicon', columnUserId: OWNER, iconId: null })])
    );
    const rows = await listMyAppListings({ userId: OWNER });
    expect(rows[0].problems.map((p) => p.code)).toEqual(['missing-icon']);
  });

  /**
   * 🔴 KILLS THE OPERAND SWAP. With `iconId: 7` present and `coverId: null`, the correct
   * wiring reports `missing-cover`; an implementation that passes `r.iconId` into the
   * `coverId` slot sees 7 there and reports nothing. The two fixture values are distinct
   * precisely so this discriminates.
   */
  it('🔴 a listing missing its COVER reports missing-cover, not missing-icon', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([stored({ id: 'apl_nocover', columnUserId: OWNER, coverId: null })])
    );
    const rows = await listMyAppListings({ userId: OWNER });
    const codes = rows[0].problems.map((p) => p.code);
    expect(codes).toEqual(['missing-cover']);
    expect(codes).not.toContain('missing-icon');
  });

  /** The mirror direction, so neither argument can be sourced from the other. */
  it('🔴 icon and cover are reported INDEPENDENTLY when both are absent', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([stored({ id: 'apl_bare', columnUserId: OWNER, iconId: null, coverId: null })])
    );
    const rows = await listMyAppListings({ userId: OWNER });
    expect(rows[0].problems.map((p) => p.code).sort()).toEqual(['missing-cover', 'missing-icon']);
  });

  /**
   * 🔴 KILLS THE SCREENSHOT-COUNT DEFAULT MUTANT (`0 → 99`). A non-zero default would make
   * `no-screenshots` unreachable, so the ONLY way to see it is a fixture that really has
   * zero and an assertion that demands the problem.
   */
  it('🔴 a listing with zero screenshots reports no-screenshots', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([stored({ id: 'apl_noshots', columnUserId: OWNER, _count: { screenshots: 0 } })])
    );
    expect((await listMyAppListings({ userId: OWNER }))[0].problems.map((p) => p.code)).toEqual([
      'no-screenshots',
    ]);
  });

  /**
   * 🔴 THE `?? 0` DEFAULT'S OWN CASE, and it exists because the obvious test could not see
   * it. An independently-built sweep mutated that default `0 → 99` and it SURVIVED a fully
   * green suite — including the zero-screenshot case above. The reason is `??`, not a
   * missing assertion: `0 ?? 99` is `0`, so with `_count` PRESENT the default is
   * unreachable by construction. It fires only when the relation is absent from the row,
   * which is what this case builds.
   *
   * 🔴 AND THE DIRECTION IS THE POINT. Absent must mean ZERO — report the problem — never
   * a number that suppresses it. A default that hides `no-screenshots` turns an incomplete
   * listing into a clean one silently, which is the same failure as dropping the advisory
   * altogether.
   */
  it('🔴 a row whose _count relation is ABSENT still reports no-screenshots', async () => {
    const row = stored({ id: 'apl_nocount', columnUserId: OWNER });
    // Drop the relation the way a narrow projection would, rather than setting it to 0 —
    // that is the only shape in which the default is reached at all.
    delete (row as unknown as Record<string, unknown>)._count;
    mockDb.appListing.findMany.mockImplementation(findManyFake([row]));
    const rows = await listMyAppListings({ userId: OWNER });
    expect(rows[0].problems.map((p) => p.code)).toEqual(['no-screenshots']);
  });

  it('the three TEXT fields are each reported on their own', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([
        stored({ id: 'apl_notext', columnUserId: OWNER, description: null }),
        stored({ id: 'apl_notag', columnUserId: OWNER, tagline: null }),
        stored({ id: 'apl_nocat', columnUserId: OWNER, category: null }),
      ])
    );
    const byId = Object.fromEntries(
      (await listMyAppListings({ userId: OWNER })).map((r) => [
        r.appListingId,
        r.problems.map((p) => p.code),
      ])
    );
    expect(byId.apl_notext).toEqual(['empty-description']);
    expect(byId.apl_notag).toEqual(['empty-tagline']);
    expect(byId.apl_nocat).toEqual(['empty-category']);
  });

  it('the select really asks for every input the advisory needs', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([stored({ id: 'apl_sel', columnUserId: OWNER })])
    );
    await listMyAppListings({ userId: OWNER });
    const select = (
      mockDb.appListing.findMany.mock.calls.at(-1)?.[0] as { select: Record<string, unknown> }
    ).select;
    for (const key of ['iconId', 'coverId', 'description', 'tagline', 'category', '_count']) {
      expect(select, `select is missing ${key}`).toHaveProperty(key);
    }
  });

  /**
   * 🔴 THE SCREENSHOT COUNT MUST BE THE FILTERED ONE. A screenshot whose `Image` was
   * deleted has nothing to display, so counting it makes `no-screenshots` a false
   * negative — the same filter the authoritative asset gate uses.
   */
  it('the screenshot count is filtered on a live Image', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([stored({ id: 'apl_f', columnUserId: OWNER })])
    );
    await listMyAppListings({ userId: OWNER });
    const select = (
      mockDb.appListing.findMany.mock.calls.at(-1)?.[0] as {
        select: { _count: { select: { screenshots: { where: unknown } } } };
      }
    ).select;
    expect(select._count.select.screenshots.where).toEqual({ imageId: { not: null } });
  });
});
