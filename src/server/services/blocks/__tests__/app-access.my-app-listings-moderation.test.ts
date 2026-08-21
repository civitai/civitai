import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `listMyAppListings` — the `lastModerationAction` widening that makes the `/apps/mine`
 * **Republish** control possible at all.
 *
 * 🔴 WHY THE FIELD IS NOT OPTIONAL POLISH. `app_listings.status = 'removed'` is written by
 * BOTH an owner self-unpublish and a moderator takedown, so the row alone cannot tell the two
 * apart — and they have opposite affordances. `republishOwnListing` refuses unless the most
 * recent moderation event is `owner-unpublish` ("This listing was removed by a moderator and
 * cannot be restored by its owner."), so without this field the page must either hide
 * Republish from an author who is entitled to it — leaving an owner unpublish a one-way door
 * only a moderator can reopen — or render a button that is guaranteed to 403. There is no
 * third option, which is what makes this a SERVER change rather than a client one.
 *
 * 🔴 RED AT BASE, BEHAVIOURALLY. On `origin/main` `listMyAppListings` does not select or
 * return this column, so every assertion below reads `undefined` where it expects a real
 * action — a failure about the payload, not about a missing module.
 *
 * The db is mocked through the canonical shared `dbMock` (a per-file mock of the db-client
 * specifier is refused by `no-direct-shared-module-mock.test.ts`).
 */

const mockDb = dbMock.dbRead;

const { listMyAppListings } = await import('~/server/services/blocks/app-access.service');

/** Distinct so no assertion's expected value can be produced by the wrong row or user. */
const OWNER = 41;

type Stored = {
  id: string;
  slug: string;
  name: string;
  status: string;
  kind: string;
  appBlockId: string | null;
  updatedAt: Date;
  icon: null;
  cover: null;
  iconId: number | null;
  coverId: number | null;
  description: string | null;
  tagline: string | null;
  category: string | null;
  _count: { screenshots: number };
  columnUserId: number;
};

function stored(over: Partial<Stored> & { id: string }): Stored {
  return {
    slug: `slug-${over.id}`,
    name: `Name ${over.id}`,
    status: 'removed',
    kind: 'offsite',
    appBlockId: null,
    updatedAt: new Date('2026-02-03T00:00:00Z'),
    icon: null,
    cover: null,
    iconId: 5,
    coverId: 8,
    description: `Description of ${over.id}`,
    tagline: `Tagline of ${over.id}`,
    category: 'utility',
    _count: { screenshots: 2 },
    columnUserId: OWNER,
    ...over,
  };
}

/** `appListing.findMany` honouring `select` — see the sibling media test for why. */
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
        for (const branch of where.OR) {
          if (typeof branch.userId === 'number') return branch.userId;
        }
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
 * The moderation-event read, honouring `where.appListingId.in`.
 *
 * 🔴 IT FILTERS, rather than returning everything. A fake that ignored the `where` would make
 * the `in`-clause unobservable: a mutant querying every listing's events (or the wrong id
 * set) would produce the same answer, and the assertion that a MOD-removed row and an
 * OWNER-removed row get DIFFERENT actions would pass either way.
 */
function eventsFake(byListingId: Record<string, string>) {
  return async (...a: unknown[]): Promise<unknown[]> => {
    const args = (a[0] ?? {}) as { where?: { appListingId?: { in: string[] } } };
    const ids = args.where?.appListingId?.in ?? Object.keys(byListingId);
    return ids
      .filter((id) => byListingId[id] != null)
      .map((id) => ({ appListingId: id, action: byListingId[id] }));
  };
}

/** One row of a listing's moderation history, for {@link historyFake}. */
type Event = { action: string; createdAt: Date; id: string };

/**
 * A moderation-event fake that holds a real multi-event HISTORY per listing and **honours
 * `orderBy` + `distinct`** the way Postgres would.
 *
 * 🔴 IT EXISTS BECAUSE `eventsFake` CANNOT SEE THE SORT. That one synthesises a single event
 * per id, so `orderBy: [{createdAt}]` is unobservable through it and a `desc` → `asc` mutant
 * SURVIVES a fully green run — reachable, not unreachable: the args object really is passed
 * and really is read by the `distinct`/`in` assertions, it just carries a key no assertion
 * and no fixture can feel. Ordering only becomes a behavioural fact once a listing has more
 * than one event, so that is what this builds.
 */
function historyFake(byListingId: Record<string, Event[]>) {
  return async (...a: unknown[]): Promise<unknown[]> => {
    const args = (a[0] ?? {}) as {
      where?: { appListingId?: { in: string[] } };
      orderBy?: Array<Record<string, 'asc' | 'desc'>>;
      distinct?: string[];
    };
    const ids = args.where?.appListingId?.in ?? Object.keys(byListingId);
    let rows: Array<Event & { appListingId: string }> = ids.flatMap((id) =>
      (byListingId[id] ?? []).map((e) => ({ ...e, appListingId: id }))
    );
    // Apply the query's OWN sort, key by key, rather than a hardcoded newest-first.
    for (const clause of [...(args.orderBy ?? [])].reverse()) {
      const [key, dir] = Object.entries(clause)[0] as ['createdAt' | 'id', 'asc' | 'desc'];
      rows = [...rows].sort((x, y) => {
        const a1 = key === 'createdAt' ? x.createdAt.getTime() : x.id;
        const b1 = key === 'createdAt' ? y.createdAt.getTime() : y.id;
        const cmp = a1 < b1 ? -1 : a1 > b1 ? 1 : 0;
        return dir === 'desc' ? -cmp : cmp;
      });
    }
    if (args.distinct?.includes('appListingId')) {
      const seen = new Set<string>();
      rows = rows.filter((r) => !seen.has(r.appListingId) && seen.add(r.appListingId));
    }
    return rows.map((r) => ({ appListingId: r.appListingId, action: r.action }));
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.appListing.findMany.mockImplementation(async () => []);
  mockDb.appCollaborator.findMany.mockImplementation(async () => []);
  mockDb.appListingModerationEvent.findMany.mockImplementation(async () => []);
});

describe('listMyAppListings — lastModerationAction', () => {
  it('🔴 tells an OWNER unpublish apart from a MODERATOR takedown, on rows that look identical', async () => {
    // Both rows are `removed` and owned by the same user. The ONLY thing that differs is the
    // last moderation event — which is exactly the situation the field exists for.
    const table = [
      stored({ id: 'apl_mine' }),
      stored({ id: 'apl_theirs' }),
      stored({ id: 'apl_live', status: 'approved' }),
    ];
    mockDb.appListing.findMany.mockImplementation(findManyFake(table));
    mockDb.appListingModerationEvent.findMany.mockImplementation(
      eventsFake({ apl_mine: 'owner-unpublish', apl_theirs: 'delist' })
    );

    const rows = await listMyAppListings({ userId: OWNER });
    const byId = Object.fromEntries(rows.map((r) => [r.appListingId, r.lastModerationAction]));
    // Literal expected values, and pairwise distinct — a mutant that returns one constant for
    // every row fails on at least two of these three.
    // 🔴 The moderator's verb is NORMALISED to `other` before it leaves the server — this
    // read is reachable by a seated editor, who has no other route to a listing's moderation
    // history, and the UI needs only "may the owner Republish". `delist` going in and `other`
    // coming out IS the disclosure boundary; asserting the raw verb here would pin the hole.
    expect(byId).toEqual({
      apl_mine: 'owner-unpublish',
      apl_theirs: 'other',
      apl_live: null,
    });
  });

  it('collapses EVERY non-owner action to the same `other`, whatever the verb', async () => {
    // 🔴 Pairwise-distinct real moderator verbs, each narrating a different enforcement
    // history — `claim` in particular says a moderator seized the app from an impersonating
    // owner. A projection that leaked any one of them fails here; one that leaked only the
    // verb it was written against would still be caught, because these are four different
    // strings and the expected value is one constant.
    const verbs = ['delist', 'purge', 'claim', 'report-dismiss'];
    const table = verbs.map((_, i) => stored({ id: `apl_v${i}` }));
    mockDb.appListing.findMany.mockImplementation(findManyFake(table));
    mockDb.appListingModerationEvent.findMany.mockImplementation(
      eventsFake(Object.fromEntries(verbs.map((v, i) => [`apl_v${i}`, v])))
    );

    const rows = await listMyAppListings({ userId: OWNER });
    expect(rows.map((r) => r.lastModerationAction)).toEqual(verbs.map(() => 'other'));
    // Positive control for that constant: the owner's own action is NOT collapsed, so this
    // assertion cannot be satisfied by a projection that hardcodes `other` for everything.
    mockDb.appListingModerationEvent.findMany.mockImplementation(
      eventsFake({ apl_v0: 'owner-unpublish' })
    );
    const again = await listMyAppListings({ userId: OWNER });
    expect(again.find((r) => r.appListingId === 'apl_v0')?.lastModerationAction).toBe(
      'owner-unpublish'
    );
  });

  it('🔴 takes the NEWEST event, not an arbitrary one — a relisted-then-self-unpublished app', async () => {
    /**
     * The history that makes `orderBy` load-bearing, and the direction that matters: an app
     * a moderator once delisted, then relisted, and whose owner has since unpublished it
     * themselves. The newest event is `owner-unpublish`, so the owner MAY restore it — and
     * the server's own guard agrees. Reading the oldest instead reports the `delist`, the row
     * hides Republish behind "a moderator removed this", and an entitled author is stranded
     * on a listing the server would have let them bring back.
     *
     * `historyFake` honours the query's own `orderBy`, so this dies on a `desc` → `asc`
     * mutation rather than surviving it — which is exactly what the single-event fake could
     * not see.
     */
    mockDb.appListing.findMany.mockImplementation(findManyFake([stored({ id: 'apl_arc' })]));
    mockDb.appListingModerationEvent.findMany.mockImplementation(
      historyFake({
        apl_arc: [
          { action: 'delist', createdAt: new Date('2026-03-01T00:00:00Z'), id: 'ev_a' },
          { action: 'relist', createdAt: new Date('2026-04-01T00:00:00Z'), id: 'ev_b' },
          { action: 'owner-unpublish', createdAt: new Date('2026-05-01T00:00:00Z'), id: 'ev_c' },
        ],
      })
    );

    const rows = await listMyAppListings({ userId: OWNER });
    expect(rows[0].lastModerationAction).toBe('owner-unpublish');

    // Structural half, next to the `distinct` assertion below: the exact sort the newest-first
    // keyset needs. `createdAt` first, `id` as the tiebreak for two events in the same instant.
    const args = mockDb.appListingModerationEvent.findMany.mock.calls[0]?.[0] as {
      orderBy: Array<Record<string, string>>;
    };
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('reads events ONLY for the removed subset', async () => {
    const table = [stored({ id: 'apl_gone' }), stored({ id: 'apl_up', status: 'approved' })];
    mockDb.appListing.findMany.mockImplementation(findManyFake(table));
    mockDb.appListingModerationEvent.findMany.mockImplementation(
      eventsFake({ apl_gone: 'owner-unpublish', apl_up: 'approve' })
    );

    const rows = await listMyAppListings({ userId: OWNER });
    const args = mockDb.appListingModerationEvent.findMany.mock.calls[0]?.[0] as {
      where: { appListingId: { in: string[] } };
      distinct: string[];
    };
    // 🔴 The `in` set is the removed rows and nothing else. Widening it would fan a
    // per-author list read out over every listing's whole moderation history.
    expect(args.where.appListingId.in).toEqual(['apl_gone']);
    // Latest-per-listing, or the map would key on an arbitrary older event.
    expect(args.distinct).toEqual(['appListingId']);
    // …and the approved row stays null even though the fake HAS an event for it. This is the
    // stale-event guard: an `approve` action leaking onto a live row would be read by
    // `ownerListingState` as… nothing, but an `owner-unpublish` one would re-open Republish
    // next to a published app.
    expect(rows.find((r) => r.appListingId === 'apl_up')?.lastModerationAction).toBeNull();
  });

  /**
   * ⚠️ LABELLED HONESTLY: this one is an INVARIANT GUARD, not regression coverage. It passes
   * on `origin/main` too — vacuously, because the query it forbids does not exist there. The
   * three tests around it are the ones that go red at base.
   */
  it('does NOT issue the events query when nothing is removed', async () => {
    mockDb.appListing.findMany.mockImplementation(
      findManyFake([stored({ id: 'apl_ok', status: 'approved' })])
    );
    const rows = await listMyAppListings({ userId: OWNER });
    expect(rows).toHaveLength(1);
    // 🔴 POSITIVE CONTROL FOR THIS ZERO: the previous test asserts the SAME mock records a
    // call when a removed row IS present. A "0 calls" assertion alone is indistinguishable
    // from a mock nothing ever reaches.
    expect(mockDb.appListingModerationEvent.findMany).not.toHaveBeenCalled();
  });

  it('a removed listing with NO recorded event comes back null, not undefined', async () => {
    // `undefined` and `null` are the same to `ownerListingState`, but the field is declared
    // non-optional on `MyAppListing` — a row that omitted it would be a lie the type tells.
    mockDb.appListing.findMany.mockImplementation(findManyFake([stored({ id: 'apl_orphan' })]));
    mockDb.appListingModerationEvent.findMany.mockImplementation(eventsFake({}));
    const rows = await listMyAppListings({ userId: OWNER });
    expect(rows[0].lastModerationAction).toBeNull();
    expect('lastModerationAction' in rows[0]).toBe(true);
  });
});
