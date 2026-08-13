import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE PORTFOLIO-LEAK REGRESSION TEST. This is the highest-risk item in the
 * collaborators feature and this suite is its guard.
 *
 * THE FIXTURE IS THE POINT: the owner has TWO apps and the editor is seated on ONE.
 * A one-app fixture cannot distinguish the correct implementation from the leaking one,
 * because with a single app "everything the owner has" and "the shared app" are the
 * same set. Every assertion below therefore names APP_B (the app the editor was never
 * invited to) explicitly.
 *
 * 🔴 WATCHED TO FAIL FIRST. Before the real implementation existed, the same fixture
 * was run against the NAIVE implementation — reusing the pre-existing
 * `appOwnerUserId`-keyed filter with the OWNER's id, which is the obvious way to make
 * an editor see any earnings at all. It returned BOTH apps, and this suite went red
 * with `expected [ 'ab_appA', 'ab_appB' ] not to contain 'ab_appB'`. That is the
 * defect this file exists to keep out.
 */

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    appBlock: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    appCollaborator: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    blockBuzzAttribution: {
      aggregate: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      groupBy: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));

const { getAppEarnings, getMyAppsEarnings } = await import(
  '~/server/services/blocks/app-collaborator-earnings.service'
);

const APP_A = 'ab_appA'; // shared with the editor
const APP_B = 'ab_appB'; // 🔴 the owner's OTHER app — must never surface to the editor
/** The store listings that BACK those blocks — the seat key since the re-key. */
const LISTING_A = 'apl_listingA';
const LISTING_B = 'apl_listingB';
/** 🔴 An OFF-SITE listing the editor is ALSO seated on. It has no block, so no earnings. */
const LISTING_OFF = 'apl_offsite';
/**
 * 🔴 THE TWO SHAPES WHERE THE KIND GATE'S TWO CLAUSES DISAGREE.
 *
 * `getAppEarnings` refuses on `!listingKindSupports(kind,'earnings') || !appBlockId`. On
 * every ordinary row the two clauses agree (onsite⇒block, offsite⇒no block), so a
 * fixture built only from ordinary rows leaves the SECOND clause dead — and the
 * `||`→`&&` mutant SURVIVES the whole suite, which is exactly what a mutation sweep
 * found. These two rows are what make each clause independently load-bearing:
 *
 *   - OFFSITE **with** a block. Not hypothetical: `mapAppBlockToListing` sets
 *     `kind: 'offsite'` while assigning `appBlockId: ab.id` unconditionally whenever the
 *     source AppBlock has an `externalUrl` (reachable via the mod proc
 *     `backfillAppListings`), and `schema.full.prisma` says to discriminate on `kind`,
 *     never on `appBlockId` nullness. Only the KIND clause refuses it — and it is
 *     pointed at APP_B, the lucrative app, so under the mutant the leak is a number.
 *   - ONSITE **without** a block — a listing whose backing AppBlock is missing or not
 *     yet linked. Only the BLOCK clause refuses it.
 */
const LISTING_OFF_WITH_BLOCK = 'apl_offsite_with_block';
const LISTING_ON_NO_BLOCK = 'apl_onsite_no_block';
const OWNER = 100;
const EDITOR = 200;
const STRANGER = 300;

/**
 * The listing table. Each row is what `resolveListingAccess` selects.
 *
 * 🔴 The OFF-SITE row is the new axis: the editor holds a real, accepted seat on it, so
 * every "the editor cannot see earnings here" assertion is about the KIND and not about
 * a missing seat.
 */
const LISTINGS: Record<string, Record<string, unknown>> = {
  [LISTING_A]: {
    id: LISTING_A,
    userId: OWNER,
    kind: 'onsite',
    appBlockId: APP_A,
    revisionOfId: null,
    revisionOf: null,
  },
  [LISTING_B]: {
    id: LISTING_B,
    userId: OWNER,
    kind: 'onsite',
    appBlockId: APP_B,
    revisionOfId: null,
    revisionOf: null,
  },
  [LISTING_OFF]: {
    id: LISTING_OFF,
    userId: OWNER,
    kind: 'offsite',
    appBlockId: null,
    revisionOfId: null,
    revisionOf: null,
  },
  // 🔴 offsite BUT carrying APP_B — the 999,999-cent app. Only the KIND clause refuses.
  [LISTING_OFF_WITH_BLOCK]: {
    id: LISTING_OFF_WITH_BLOCK,
    userId: OWNER,
    kind: 'offsite',
    appBlockId: APP_B,
    revisionOfId: null,
    revisionOf: null,
  },
  // 🔴 onsite BUT with no block. Only the BLOCK clause refuses.
  [LISTING_ON_NO_BLOCK]: {
    id: LISTING_ON_NO_BLOCK,
    userId: OWNER,
    kind: 'onsite',
    appBlockId: null,
    revisionOfId: null,
    revisionOf: null,
  },
};

/** Every attribution row in the fixture DB, per app. */
const LEDGER = [
  { appBlockId: APP_A, appOwnerUserId: OWNER, status: 'confirmed', share: 500, gross: 1000 },
  { appBlockId: APP_A, appOwnerUserId: OWNER, status: 'paid_out', share: 250, gross: 500 },
  // APP_B is far more lucrative — so a leak is unmissable in the numbers, not just
  // in the id list.
  {
    appBlockId: APP_B,
    appOwnerUserId: OWNER,
    status: 'confirmed',
    share: 999_999,
    gross: 1_999_999,
  },
];

/**
 * A `groupBy` fake that HONOURS the `where` clause it is handed.
 *
 * 🔴 This is the instrument, so validate it before reading its verdict: a fake that
 * ignored `where.appBlockId` would return everything to everybody and make the leak
 * assertions fail even for a correct implementation — or, worse, a fake that returned
 * a hardcoded single row would make them PASS for a leaking one. The positive/negative
 * control test at the bottom of this describe exercises both directions.
 */
function wireGroupBy() {
  mockDb.blockBuzzAttribution.groupBy.mockImplementation(async (args: unknown) => {
    const w = (args as { where: { appBlockId?: { in?: string[] }; status?: { in?: string[] } } })
      .where;
    const allowed = w.appBlockId?.in;
    const statuses = w.status?.in ?? ['confirmed', 'paid_out'];
    const rows = LEDGER.filter(
      (r) =>
        (allowed === undefined || allowed.includes(r.appBlockId)) && statuses.includes(r.status)
    );
    const acc = new Map<
      string,
      { appBlockId: string; appOwnerUserId: number; share: number; n: number }
    >();
    for (const r of rows) {
      const k = `${r.appBlockId}:${r.appOwnerUserId}`;
      const prev = acc.get(k) ?? {
        appBlockId: r.appBlockId,
        appOwnerUserId: r.appOwnerUserId,
        share: 0,
        n: 0,
      };
      acc.set(k, { ...prev, share: prev.share + r.share, n: prev.n + 1 });
    }
    return [...acc.values()].map((v) => ({
      appBlockId: v.appBlockId,
      appOwnerUserId: v.appOwnerUserId,
      _sum: { appOwnerShareCents: v.share },
      _count: v.n,
    }));
  });
}

/** An `aggregate` fake that honours appBlockId + appOwnerUserId + status. */
function wireAggregate() {
  mockDb.blockBuzzAttribution.aggregate.mockImplementation(async (args: unknown) => {
    const w = (
      args as {
        where: { appBlockId?: string; appOwnerUserId?: number; status?: string };
      }
    ).where;
    const rows = LEDGER.filter(
      (r) =>
        (w.appBlockId === undefined || r.appBlockId === w.appBlockId) &&
        (w.appOwnerUserId === undefined || r.appOwnerUserId === w.appOwnerUserId) &&
        (w.status === undefined || r.status === w.status)
    );
    return {
      _count: rows.length,
      _sum: {
        usdAmountCents: rows.reduce((s, r) => s + r.gross, 0),
        appOwnerShareCents: rows.reduce((s, r) => s + r.share, 0),
      },
    };
  });
}

/** Owner owns both apps; the editor holds an ACCEPTED seat on APP_A only. */
function wireAccess() {
  mockDb.appBlock.findUnique.mockImplementation(async (args: unknown) => {
    const id = (args as { where: { id: string } }).where.id;
    if (id !== APP_A && id !== APP_B) return null;
    return { id, app: { userId: OWNER } };
  });
  mockDb.appBlock.findMany.mockImplementation(async (args: unknown) => {
    const w = (args as { where: Record<string, unknown> }).where;
    if ((w as { app?: { userId: number } }).app) {
      return (w as { app: { userId: number } }).app.userId === OWNER
        ? [
            { id: APP_A, app: { userId: OWNER } },
            { id: APP_B, app: { userId: OWNER } },
          ]
        : [];
    }
    const ids = (w as { id?: { in: string[] } }).id?.in ?? [];
    return ids.map((id) => ({ id, app: { userId: OWNER } }));
  });
  mockDb.appListing.findUnique.mockImplementation(async (args: unknown) => {
    const id = (args as { where: { id: string } }).where.id;
    return LISTINGS[id] ?? null;
  });
  // The seated-LISTINGS → backing-BLOCKS hop, honouring BOTH filters the service sends:
  // `kind` and `appBlockId: { not: null }`.
  //
  // 🔴 The two are applied INDEPENDENTLY here on purpose. Collapsing them (e.g. treating
  // "offsite" as implying "no block") would make LISTING_OFF_WITH_BLOCK unrepresentable
  // through this fake, and the kind gate would then be certified by a fixture that
  // cannot express the case it exists for.
  mockDb.appListing.findMany.mockImplementation(async (args: unknown) => {
    const w = (args as { where: { id: { in: string[] }; kind?: string; appBlockId?: unknown } })
      .where;
    return Object.values(LISTINGS)
      .filter((l) => w.id.in.includes(l.id as string))
      .filter((l) => (w.kind === undefined ? true : l.kind === w.kind))
      .filter((l) => (w.appBlockId === undefined ? true : l.appBlockId != null))
      .map((l) => ({ appBlockId: l.appBlockId }));
  });
  // 🔴 The editor holds THREE accepted seats: the on-site LISTING_A, the off-site
  // LISTING_OFF, and the off-site-WITH-A-BLOCK LISTING_OFF_WITH_BLOCK. The third is the
  // one that can leak a block id — and therefore money — into a block-keyed query.
  const SEATED = new Set([LISTING_A, LISTING_OFF, LISTING_OFF_WITH_BLOCK]);
  mockDb.appCollaborator.findFirst.mockImplementation(async (args: unknown) => {
    const w = (args as { where: { appListingId: string; userId: number; status?: string } }).where;
    const seated = SEATED.has(w.appListingId);
    return seated && w.userId === EDITOR && w.status === 'accepted' ? { userId: EDITOR } : null;
  });
  mockDb.appCollaborator.findMany.mockImplementation(async (args: unknown) => {
    const w = (args as { where: { userId?: number; status?: string } }).where;
    return w.userId === EDITOR && w.status === 'accepted'
      ? [...SEATED].map((appListingId) => ({ appListingId }))
      : [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  wireAccess();
  wireGroupBy();
  wireAggregate();
});

describe('getMyAppsEarnings — 🔴 the editor must never see the owner’s other app', () => {
  it('INSTRUMENT CONTROLS: the groupBy fake both filters and can return multiple apps', async () => {
    // POSITIVE — an unrestricted call sees BOTH apps (so a later "only APP_A" result is
    // a fact about the code, not about a fake that can only ever return one row).
    const all = (await mockDb.blockBuzzAttribution.groupBy({
      where: { status: { in: ['confirmed', 'paid_out'] } },
    })) as Array<{ appBlockId: string; _count: number }>;
    // Grouped by (appBlockId, appOwnerUserId), so APP_A's two rows collapse to ONE
    // group of count 2 — asserting the count too proves the fake really aggregates
    // rather than returning a canned pair.
    expect(all.map((r) => r.appBlockId).sort()).toEqual([APP_A, APP_B]);
    expect(all.find((r) => r.appBlockId === APP_A)!._count).toBe(2);
    // NEGATIVE — the filter genuinely bites: APP_B disappears when excluded.
    const only = (await mockDb.blockBuzzAttribution.groupBy({
      where: { appBlockId: { in: [APP_A] }, status: { in: ['confirmed', 'paid_out'] } },
    })) as Array<{ appBlockId: string }>;
    expect(only.map((r) => r.appBlockId)).toEqual([APP_A]);
  });

  it('the OWNER sees both of their apps', async () => {
    const rows = await getMyAppsEarnings({ userId: OWNER });
    expect(rows.map((r) => r.appBlockId).sort()).toEqual([APP_A, APP_B].sort());
    expect(rows.every((r) => r.role === 'owner')).toBe(true);
  });

  it('🔴 the EDITOR sees ONLY the shared app — APP_B is absent', async () => {
    const rows = await getMyAppsEarnings({ userId: EDITOR });
    const ids = rows.map((r) => r.appBlockId);
    expect(ids).toEqual([APP_A]);
    // Stated as its own assertion so the failure message names the leak directly.
    expect(ids).not.toContain(APP_B);
  });

  it('🔴 the EDITOR’s totals equal APP_A’s alone — not the portfolio total', async () => {
    // A leak that returned the right id list but the wrong SUM would pass the id
    // assertion above. Pin the number too.
    const rows = await getMyAppsEarnings({ userId: EDITOR });
    expect(rows).toHaveLength(1);
    expect(rows[0].lifetimeShareCents).toBe(750); // 500 confirmed + 250 paid_out
    expect(rows[0].lifetimeShareCents).not.toBe(750 + 999_999);
    expect(rows[0].role).toBe('editor');
  });

  it('a stranger sees nothing', async () => {
    expect(await getMyAppsEarnings({ userId: STRANGER })).toEqual([]);
  });

  it('🔴 STRUCTURAL: the groupBy is filtered by `appBlockId IN <permitted set>`', async () => {
    // A mutation sweep showed the id-list assertions alone SURVIVE removal of this
    // filter, because the final `allIds.map` is a second, independent barrier that
    // hides the leak in the OUTPUT while the QUERY still fetched the owner's whole
    // portfolio. Defence in depth is good; relying on it to be the only guard is not —
    // the rows are in memory either way, and the next refactor of that map re-opens it.
    await getMyAppsEarnings({ userId: EDITOR });
    const args = mockDb.blockBuzzAttribution.groupBy.mock.calls[0][0] as {
      where: { appBlockId?: { in: string[] }; appOwnerUserId?: number };
    };
    expect(args.where.appBlockId, 'the app-scope filter must be present').toBeDefined();
    expect(args.where.appBlockId!.in).toEqual([APP_A]);
    expect(args.where.appBlockId!.in).not.toContain(APP_B);
    // …and NEVER an appOwnerUserId-only filter, which is the user-wide axis.
    expect(args.where.appOwnerUserId).toBeUndefined();
  });

  it('🔴 pre-transfer rows attributed to a PREVIOUS owner are excluded', async () => {
    // The transfer decision leaves `appOwnerUserId` alone, so an app-scoped query on
    // appBlockId ALONE would show the new owner the old owner's money. The second
    // scope axis (current owner) is what stops that.
    mockDb.blockBuzzAttribution.groupBy.mockResolvedValue([
      { appBlockId: APP_A, appOwnerUserId: OWNER, _sum: { appOwnerShareCents: 750 }, _count: 2 },
      // An OLD owner's rows on the same app.
      { appBlockId: APP_A, appOwnerUserId: 999, _sum: { appOwnerShareCents: 424_242 }, _count: 7 },
    ]);
    const rows = await getMyAppsEarnings({ userId: EDITOR });
    expect(rows[0].lifetimeShareCents).toBe(750);
    expect(rows[0].lifetimeCount).toBe(2);
  });
});

describe('getAppEarnings — per-listing, fail-closed', () => {
  it('the owner reads the listing’s summary', async () => {
    const res = await getAppEarnings({ appListingId: LISTING_A, userId: OWNER });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.role).toBe('owner');
    expect(res.appBlockId).toBe(APP_A);
    expect(res.summary.confirmed.shareCents).toBe(500);
    expect(res.summary.paidOut.shareCents).toBe(250);
  });

  it('the accepted editor reads the SHARED listing’s summary', async () => {
    const res = await getAppEarnings({ appListingId: LISTING_A, userId: EDITOR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.role).toBe('editor');
    expect(res.summary.confirmed.shareCents).toBe(500);
  });

  it('🔴 the editor is REFUSED on the owner’s other listing — and no aggregate is run', async () => {
    const res = await getAppEarnings({ appListingId: LISTING_B, userId: EDITOR });
    expect(res).toEqual({ ok: false, appListingId: LISTING_B, reason: 'notPermitted' });
    // Fail-closed means fail EARLY: refusing after running the query would still have
    // put the owner's numbers in memory on this request.
    expect(mockDb.blockBuzzAttribution.aggregate).not.toHaveBeenCalled();
  });

  it('🔴 refusal is `notPermitted`, NOT a zeroed summary', async () => {
    // A zero here would be indistinguishable from "this app earned nothing" — the
    // fabricated-zero trap. The discriminated union makes that unrepresentable.
    const res = await getAppEarnings({ appListingId: LISTING_B, userId: STRANGER });
    expect(res.ok).toBe(false);
    expect(res).not.toHaveProperty('summary');
  });

  it('a missing listing is `notFound`, distinct from `notPermitted`', async () => {
    const res = await getAppEarnings({ appListingId: 'apl_nope', userId: OWNER });
    expect(res).toEqual({ ok: false, appListingId: 'apl_nope', reason: 'notFound' });
  });

  it('🔴 the query carries BOTH scopes (appBlockId AND the current owner)', async () => {
    // A structural assertion on the WHERE clause, because dropping either axis is the
    // leak and a numeric assertion alone would not localise which axis went missing.
    await getAppEarnings({ appListingId: LISTING_A, userId: EDITOR });
    const calls = mockDb.blockBuzzAttribution.aggregate.mock.calls as Array<
      [{ where: Record<string, unknown> }]
    >;
    expect(calls.length).toBeGreaterThan(0);
    for (const [args] of calls) {
      expect(args.where.appBlockId).toBe(APP_A);
      expect(args.where.appOwnerUserId).toBe(OWNER);
    }
  });

  // -------------------------------------------------------------------------
  // 🔴 THE KIND AXIS — earnings are structurally ON-SITE ONLY.
  // -------------------------------------------------------------------------

  describe('🔴 OFF-SITE: the capability is ABSENT, not erroring and not a zero', () => {
    /**
     * `BlockBuzzAttribution` is keyed on `appBlockId`. An off-site listing has no
     * AppBlock, so no attribution row can ever belong to it — the `earnings: false` cell
     * of `CAPABILITIES_BY_KIND`. The refusal has to be an explicit `unsupportedKind`:
     *
     *   - a THROW would read to the client as "something went wrong", and an off-site
     *     developer would file a bug about their broken earnings page; and
     *   - a ZEROED SUMMARY would read as "your app earned nothing", which is worse — it
     *     is a plausible number for a claim the schema cannot support at all.
     */
    it('the OWNER of an off-site listing gets `unsupportedKind`', async () => {
      const res = await getAppEarnings({ appListingId: LISTING_OFF, userId: OWNER });
      expect(res).toEqual({ ok: false, appListingId: LISTING_OFF, reason: 'unsupportedKind' });
    });

    it('🔴 a genuinely SEATED off-site editor gets `unsupportedKind` too — it is the KIND, not the seat', async () => {
      // The fixture seats EDITOR on LISTING_OFF for real, so this cannot be confused
      // with `notPermitted`.
      const res = await getAppEarnings({ appListingId: LISTING_OFF, userId: EDITOR });
      expect(res).toEqual({ ok: false, appListingId: LISTING_OFF, reason: 'unsupportedKind' });
    });

    it('🔴 the two refusals are DISTINGUISHABLE — a stranger still gets `notPermitted`', async () => {
      // Collapsing the two would tell an off-site owner they lack permission on their
      // own listing.
      const stranger = await getAppEarnings({ appListingId: LISTING_OFF, userId: STRANGER });
      expect(stranger).toMatchObject({ reason: 'notPermitted' });
      const owner = await getAppEarnings({ appListingId: LISTING_OFF, userId: OWNER });
      expect(owner).toMatchObject({ reason: 'unsupportedKind' });
    });

    it('NO aggregate is run — there is no id to aggregate on', async () => {
      await getAppEarnings({ appListingId: LISTING_OFF, userId: OWNER });
      expect(mockDb.blockBuzzAttribution.aggregate).not.toHaveBeenCalled();
    });

    it('🔴 POSITIVE CONTROL: the SAME owner on the ON-SITE listing does get a summary', async () => {
      // Without this, "no aggregate ran" is indistinguishable from an aggregate mock
      // nothing ever calls.
      const res = await getAppEarnings({ appListingId: LISTING_A, userId: OWNER });
      expect(res.ok).toBe(true);
      expect(mockDb.blockBuzzAttribution.aggregate).toHaveBeenCalled();
    });

    /**
     * 🔴 THE TWO CLAUSES OF THE KIND GATE, MADE INDEPENDENTLY LOAD-BEARING.
     *
     * The guard is `!listingKindSupports(kind,'earnings') || !appBlockId`. Every fixture
     * above satisfies BOTH clauses at once (offsite AND blockless), so each one alone is
     * sufficient there — and the `||`→`&&` mutant, which only refuses when both fire,
     * behaves identically on every one of them. It survived the full suite for exactly
     * that reason: the second clause was never observed, and the comment claiming it was
     * "asserted TWO ways" described an intention, not a fixture.
     *
     * Each test below satisfies EXACTLY ONE clause, so it is red under `&&` and green
     * under `||` — and neither can be satisfied by the other clause's guard, which is
     * what makes the kill attributable rather than a neighbour's.
     */
    describe('🔴 the `||` is not decorative — one clause fires per case', () => {
      it('CLAUSE 1 ONLY (kind): an OFF-SITE listing that HAS a block is refused', async () => {
        // `appBlockId` is APP_B (truthy), so `!access.appBlockId` is FALSE here — the
        // kind clause is the only thing that can refuse.
        const res = await getAppEarnings({ appListingId: LISTING_OFF_WITH_BLOCK, userId: OWNER });
        expect(res).toEqual({
          ok: false,
          appListingId: LISTING_OFF_WITH_BLOCK,
          reason: 'unsupportedKind',
        });
        // BEHAVIOURAL, not just the label: under `&&` this call reaches the aggregate and
        // returns APP_B's 999,999 cents on a listing whose kind says it cannot earn.
        expect(mockDb.blockBuzzAttribution.aggregate).not.toHaveBeenCalled();
      });

      it('CLAUSE 2 ONLY (block): an ON-SITE listing with NO block is refused', async () => {
        // `listingKindSupports('onsite','earnings')` is TRUE here, so the kind clause is
        // FALSE — the block clause is the only thing that can refuse.
        const res = await getAppEarnings({ appListingId: LISTING_ON_NO_BLOCK, userId: OWNER });
        expect(res).toEqual({
          ok: false,
          appListingId: LISTING_ON_NO_BLOCK,
          reason: 'unsupportedKind',
        });
        // Under `&&` this would run four aggregates with `appBlockId: null`.
        expect(mockDb.blockBuzzAttribution.aggregate).not.toHaveBeenCalled();
      });

      it('🔴 POSITIVE CONTROL: the fixture rows really do have the disagreeing shapes', async () => {
        // The instrument, not the code: if the LISTINGS table did not actually hold an
        // offsite-with-block and an onsite-without-block row, both tests above would be
        // green for the wrong reason (an ordinary offsite/blockless row refuses under
        // `&&` too).
        const off = (await mockDb.appListing.findUnique({
          where: { id: LISTING_OFF_WITH_BLOCK },
        })) as { kind: string; appBlockId: string | null };
        expect(off.kind).toBe('offsite');
        expect(off.appBlockId).toBe(APP_B);
        const on = (await mockDb.appListing.findUnique({
          where: { id: LISTING_ON_NO_BLOCK },
        })) as { kind: string; appBlockId: string | null };
        expect(on.kind).toBe('onsite');
        expect(on.appBlockId).toBeNull();
      });

      it('a SEATED editor on the offsite-with-block listing is refused too — kind, not seat', async () => {
        const res = await getAppEarnings({ appListingId: LISTING_OFF_WITH_BLOCK, userId: EDITOR });
        expect(res).toMatchObject({ reason: 'unsupportedKind' });
      });
    });
  });

  describe('🔴 getMyAppsEarnings drops the off-site seat entirely', () => {
    it('the editor’s rows name only the ON-SITE app, though they hold TWO accepted seats', async () => {
      // The off-site seat is real and accepted; it contributes no block id, so it cannot
      // widen a block-keyed money query — and it must not appear as a zeroed row either,
      // which would invite the same "earned nothing" misreading.
      const rows = await getMyAppsEarnings({ userId: EDITOR });
      expect(rows.map((r) => r.appBlockId)).toEqual([APP_A]);
    });

    it('POSITIVE CONTROL: the fixture really does give the editor THREE accepted seats', async () => {
      const seats = (await mockDb.appCollaborator.findMany({
        where: { userId: EDITOR, status: 'accepted' },
      })) as Array<{ appListingId: string }>;
      expect(seats.map((s) => s.appListingId).sort()).toEqual(
        [LISTING_A, LISTING_OFF, LISTING_OFF_WITH_BLOCK].sort()
      );
    });

    /**
     * 🔴 THE MONEY READ, on the shape where "offsite" and "has no block" disagree.
     *
     * `getMyAppsEarnings` has NO kind gate of its own — it trusts the id set
     * `resolveAccessibleAppBlockIds` hands it. So an off-site listing that carries a
     * block is the one input that can put a real, earning block id in front of a
     * seat-only holder on a listing whose kind declares `earnings: false`.
     */
    it('🔴 an OFF-SITE seat on a listing that HAS a block yields NO row and NO money', async () => {
      const rows = await getMyAppsEarnings({ userId: EDITOR });
      expect(rows.map((r) => r.appBlockId)).toEqual([APP_A]);
      expect(rows.map((r) => r.appBlockId)).not.toContain(APP_B);
      // The number, not just the id list: APP_B is the 999,999-cent app, so a leak here
      // is a money figure and the assertion should say so.
      expect(rows.reduce((s, r) => s + r.lifetimeShareCents, 0)).toBe(750);
    });

    it('🔴 STRUCTURAL: the groupBy never even ASKS for the off-site listing’s block', async () => {
      // The output-only assertion above can be satisfied by the final `allIds.map`
      // barrier while the QUERY still fetched the row. Pin the WHERE too.
      await getMyAppsEarnings({ userId: EDITOR });
      const args = mockDb.blockBuzzAttribution.groupBy.mock.calls[0][0] as {
        where: { appBlockId?: { in: string[] } };
      };
      expect(args.where.appBlockId!.in).toEqual([APP_A]);
    });
  });
});
