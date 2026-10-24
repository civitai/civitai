import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppViewsService from '../app-views.service';

/**
 * 🔴 DOES A VOIDED ATTRIBUTION ROW DISAPPEAR FROM THE OWNER'S `runs` — AND DOES EVERY
 * NON-VOIDED ROW ACTUALLY SURVIVE?
 *
 * Both questions, because the two failure directions are not symmetric in cost, and on THIS
 * rail the over-filtering half is not hypothetical — it is the shape the sibling note in
 * `app-analytics.service.ts` warns about by name:
 *   · UNDER-filtering counts a private run as a run and sums its Buzz into the dashboard of
 *     the delisted app being reviewed. That is the leak the private-run feature exists to
 *     prevent.
 *   · OVER-filtering silently zeroes the owner's run count. The documented trap is the
 *     narrow spelling `voidedReason: { not: 'manual_review' }` — `voided_reason` is NULLABLE
 *     and NULL *is* the ordinary `tracked` population, so Prisma's `not` drops every real
 *     row. This file therefore asserts the SURVIVING direction on every case; a filter that
 *     has only ever been watched return fewer rows is indistinguishable from one that
 *     returns none.
 *
 * ── WHY THE FILTER IS A DENYLIST, AND WHY THAT IS TESTED RATHER THAN ASSERTED ────
 * 🔴 `block_spend_attribution_status_check` permits SIX values —
 * `tracked, pending, confirmed, voided, paid_out, held` (read off the live constraint, not
 * inferred from a migration). So the predicate must exclude the ONE voided value rather than
 * allowlist the one current healthy value: `status: 'tracked'` would silently drop a row the
 * moment the payout rail starts writing `confirmed` / `paid_out`, which is the same
 * silent-deletion failure as the nullability trap, arriving later.
 *
 * 🔴 SO THE FIXTURES SPAN ALL FIVE NON-VOIDED STATUSES, AND THAT IS NOT BELT-AND-BRACES —
 * it is a hole that was measured open. With only four statuses represented, a THREE-value
 * allowlist (`status: { in: ['tracked','confirmed','paid_out'] }`) passed all ten cases
 * green while silently dropping `pending` and `held`. An allowlist is caught here only to
 * the extent the fixtures cover the CONSTRAINT's value space rather than the statuses that
 * happen to exist in the table today.
 *
 * ── WHY THIS IS NOT A `where`-SHAPE TEST ────────────────────────────────────────
 * 🔴 ASSERTING THE `where` OBJECT WOULD BE DERIVING THE EXPECTATION FROM THE
 * IMPLEMENTATION. `expect(where).toMatchObject({ status: { not: 'voided' } })` passes whether
 * or not that predicate excludes anything, and it cannot see the read that has no `where`
 * object at all — the raw per-bucket series. Both reads are measured here through an
 * in-memory evaluator that applies the service's REAL `where` (and the real statement's own
 * bound parameters) to a fixture row set and returns real counts.
 */

type Row = {
  appBlockId: string;
  status: string;
  voidedReason: string | null;
  buzzAmount: number;
  attributedAt: Date;
};

const OWNER_ID = 4242;
const OWNED_ID = 'apb_void_fixture';
/** A SECOND owned app, so the reads' `IN (ownedIds)` is exercised rather than assumed. */
const OWNED_ID_2 = 'apb_void_fixture_2';
/** An app the caller does NOT own, in range and NOT voided — the ownership-bound control. */
const FOREIGN_ID = 'apb_someone_elses_app';

const RANGE_FROM = new Date('2026-06-01T00:00:00Z');
const RANGE_TO = new Date('2026-06-20T00:00:00Z');
/** 19 days ⇒ `resolveRange` picks `granularity: 'day'`, which the series shim mirrors. */

/** The excluded value, re-declared here ONLY so a wrong constant in the service is visible. */
const VOIDED = 'voided';

/**
 * 🔴 EVERY BUZZ VALUE IS DISTINCT, AND NO FIXTURE BUZZ VALUE EQUALS ANY BUZZ TOTAL AN
 * ASSERTION NAMES (fixtures 7/11/13/17/19/23/29/31/37/41/43/47 vs the asserted totals 179,
 * 120 and 0 — 250 and 71 appear only in comments, so they are named here as context rather
 * than as part of the claim). A
 * fixture that can only ever produce the asserted constant's own value cannot see a mutant
 * that hardcodes the literal, so it would SURVIVE a fully green suite.
 *
 * ⚠️ SCOPED TO THE BUZZ AXIS DELIBERATELY, because the unscoped claim is FALSE and used to be
 * written here: `TRACKED_A.buzzAmount` is 7 and `runs.count` is asserted as 7. It is not
 * exploitable — no case runs `TRACKED_A` alone, and `SURVIVING` sums to 179 — but the
 * sentence's whole job is to be checkable, so it states what actually holds.
 *
 * Bucket days deliberately COLLIDE across the void boundary — the `self_spend` row shares
 * 06-02 with a tracked row and the `manual_review` row shares 06-04 — so the series is
 * discriminating rather than trivially separable, and one surviving bucket holds TWO rows so
 * a shim that returns 1 everywhere is visible.
 */
const TRACKED_A: Row = {
  appBlockId: OWNED_ID,
  status: 'tracked',
  voidedReason: null,
  buzzAmount: 7,
  attributedAt: new Date('2026-06-02T09:00:00Z'),
};
const TRACKED_B: Row = {
  appBlockId: OWNED_ID_2,
  status: 'tracked',
  voidedReason: null,
  buzzAmount: 11,
  attributedAt: new Date('2026-06-03T09:00:00Z'),
};
/** 🔴 Kills the allowlist mutant: a payout-rail status that MUST still count as a run. */
const CONFIRMED_C: Row = {
  appBlockId: OWNED_ID,
  status: 'confirmed',
  voidedReason: null,
  buzzAmount: 13,
  attributedAt: new Date('2026-06-04T09:00:00Z'),
};
/** 🔴 Same, for the terminal payout status. */
const PAID_OUT_D: Row = {
  appBlockId: OWNED_ID,
  status: 'paid_out',
  voidedReason: null,
  buzzAmount: 17,
  attributedAt: new Date('2026-06-05T09:00:00Z'),
};
/** A second surviving row on D's day, so one bucket reads 2 rather than 1. */
const TRACKED_J: Row = {
  appBlockId: OWNED_ID,
  status: 'tracked',
  voidedReason: null,
  buzzAmount: 41,
  attributedAt: new Date('2026-06-05T17:00:00Z'),
};
/**
 * 🔴 `pending` AND `held` EXIST BECAUSE OF A MEASURED HOLE, and without them the denylist
 * case below is far weaker than its own name. The CHECK constraint permits SIX statuses;
 * the fixtures originally carried four (`tracked`, `confirmed`, `paid_out`, `voided`), so a
 * THREE-value allowlist — `status: { in: ['tracked','confirmed','paid_out'] }` — passed all
 * ten cases GREEN while silently dropping exactly the two statuses nothing covered. That is
 * the real shape of the failure this file exists to prevent, and it walked the whole suite.
 *
 * Worse, under that mutant the aggregate allowlists while the raw series still denylists, so
 * the two reads DISAGREE for a `pending` row and nothing noticed — which means the service
 * comment's "one constant, so the two cannot drift" had no test behind it either.
 *
 * So the fixtures now cover the constraint's full value space, not the statuses that happen
 * to exist in the table today.
 */
const PENDING_K: Row = {
  appBlockId: OWNED_ID,
  status: 'pending',
  voidedReason: null,
  buzzAmount: 43,
  attributedAt: new Date('2026-06-08T09:00:00Z'),
};
const HELD_L: Row = {
  appBlockId: OWNED_ID,
  status: 'held',
  voidedReason: null,
  buzzAmount: 47,
  attributedAt: new Date('2026-06-09T09:00:00Z'),
};

/**
 * The PRE-EXISTING void population — the app owner spending on their own app. Measured on the
 * live table before shipping: 582 of 639 rows, and every one of them `self_spend` with
 * `app_owner_user_id = user_id`. These rows are why the filter changes ~91% of the displayed
 * run count, and they carry a NULL-vs-value contrast against the tracked rows above.
 */
const VOIDED_SELF_E: Row = {
  appBlockId: OWNED_ID,
  status: VOIDED,
  voidedReason: 'self_spend',
  buzzAmount: 19,
  attributedAt: new Date('2026-06-02T15:00:00Z'),
};
const VOIDED_SELF_F: Row = {
  appBlockId: OWNED_ID,
  status: VOIDED,
  voidedReason: 'self_spend',
  buzzAmount: 23,
  attributedAt: new Date('2026-06-06T09:00:00Z'),
};
/**
 * A `manual_review`-voided row.
 *
 * ⚠️ LABELLED "THE PRIVATE RUN" UNTIL THE WRITE-SIDE CHANGE, AND THAT IS NO LONGER WHAT IT
 * COVERS. A private run now writes NO row, so this fixture can no longer be produced by one.
 *
 * 🔴 NOTHING ELSE PRODUCES IT EITHER — SAY SO RATHER THAN SUPPLYING A REASON. A previous
 * correction claimed two live sources: historical private runs, and `backpay.service.ts`
 * writing `status: 'held', voidedReason: 'manual_review'`. BOTH ARE FALSE. The flag has
 * been base-off with no rollout for its whole life, so no private run ever wrote a row;
 * and backpay writes `blockSubscriptionAttribution` — a DIFFERENT TABLE — with
 * `status: 'held'`, which this file's `status = 'voided'` filter would not exclude anyway.
 * That claim refuted itself: a `held` write cannot produce a `VOIDED` fixture.
 *
 * ✅ THE REASON THIS FIXTURE STILL EARNS ITS PLACE, which is NOT the one that was written:
 * it proves the denylist excludes a voided row WHATEVER its `voidedReason` — i.e. that the
 * predicate keys on `status` and not on the reason. Every other voided fixture here is
 * `self_spend`, so without this one an implementation that narrowed to
 * `voidedReason: 'self_spend'` would stay green. That is a live regression it catches, and
 * it does not depend on any producer existing.
 *
 * 🔴 What it must NOT be read as is coverage of the write-side exclusion; nothing here
 * exercises that. `buzz-attribution.private-run-void.test.ts` owns it.
 */
const VOIDED_REVIEW_G: Row = {
  appBlockId: OWNED_ID,
  status: VOIDED,
  voidedReason: 'manual_review',
  buzzAmount: 29,
  attributedAt: new Date('2026-06-04T15:00:00Z'),
};

/** In range, NOT voided, but somebody else's app — must never reach this owner's numbers. */
const FOREIGN_H: Row = {
  appBlockId: FOREIGN_ID,
  status: 'tracked',
  voidedReason: null,
  buzzAmount: 31,
  attributedAt: new Date('2026-06-07T09:00:00Z'),
};
/** Owned and NOT voided, but BEFORE `from` — the range-bound control. */
const OUT_OF_RANGE_I: Row = {
  appBlockId: OWNED_ID,
  status: 'tracked',
  voidedReason: null,
  buzzAmount: 37,
  attributedAt: new Date('2026-05-15T09:00:00Z'),
};

/** Owned, in range, and NOT voided: 7 rows, 179 Buzz — all five non-voided statuses. */
const SURVIVING = [TRACKED_A, TRACKED_B, CONFIRMED_C, PAID_OUT_D, TRACKED_J, PENDING_K, HELD_L];
/** Owned, in range, and voided: 3 rows, 71 Buzz. */
const VOIDED_ROWS = [VOIDED_SELF_E, VOIDED_SELF_F, VOIDED_REVIEW_G];
/** The rows no read may ever return, whatever the status predicate does. */
const NEVER_VISIBLE = [FOREIGN_H, OUT_OF_RANGE_I];

const ALL_ROWS = [...SURVIVING, ...VOIDED_ROWS, ...NEVER_VISIBLE];

let rows: Row[] = [];

/**
 * The `where`-evaluator. Deliberately LITERAL: anything the service starts using that this
 * does not understand shows up as an unhandled key rather than being silently ignored, which
 * would make every case below vacuous.
 */
function matches(row: Row, where: Record<string, any>): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    switch (key) {
      case 'appBlockId':
        if (!cond.in.includes(row.appBlockId)) return false;
        break;
      case 'attributedAt':
        if (row.attributedAt < cond.gte || row.attributedAt > cond.lte) return false;
        break;
      case 'status':
        // 🔴 EVERY PLAUSIBLE SPELLING IS EVALUATED, NOT JUST THE ONE THE SERVICE USES — and
        // that is a CORRECTION, made because the first version threw on anything but
        // `{ not: X }`. The allowlist mutant (`status: 'tracked'`) then died with
        // `TypeError: Cannot use 'in' operator to search for 'not' in tracked` raised by
        // THIS function, rather than on the assertion in the case written to catch it. The
        // mutant was being killed by the harness refusing a shape, so that case measured the
        // predicate's SHAPE and not its CONSEQUENCE — and would have passed just as happily
        // against an allowlist spelled in a shape the evaluator did happen to understand.
        // Evaluating them for real is what makes the denylist case a measurement.
        // THREE SHAPES, and only three, because only three can reach here: the one the
        // service emits (`{ not: <string> }`), plus the two an allowlist MUTANT emits
        // (a bare string, and `{ in: [...] }`). Those two are evaluated rather than
        // thrown on for a measured reason — while this branch threw on them, the
        // allowlist mutant died with a `TypeError` from THIS function instead of on the
        // assertion written to catch it, so the denylist case was measuring the
        // predicate's SHAPE and not its CONSEQUENCE.
        //
        // 🔴 EVERYTHING ELSE THROWS, INCLUDING SPELLINGS THAT ARE SEMANTICALLY CORRECT
        // (`{ not: { equals: X } }`, `{ notIn: [X] }`, a top-level `NOT:`). Those were
        // modelled for a whole round and are deliberately gone: no code emits them, so
        // the branches were reachable only from the tests written to cover them — and two
        // of this change's four review rounds spent their findings on defects inside that
        // dead scaffolding. A future refactor to an equivalent spelling now fails LOUDLY
        // here, which is the safe direction and the whole point of the `default` below.
        if (typeof cond === 'string') {
          if (row.status !== cond) return false;
        } else if (cond && typeof cond === 'object' && typeof cond.not === 'string') {
          // 🔴 `typeof === 'string'` IS LOAD-BEARING, not defensive. A bare `===` against
          // a nested operand object is never equal, so it excludes NOTHING while producing
          // a failure set byte-identical to the filter being DELETED — present-and-correct
          // code reported as a missing filter. Throwing is the only honest alternative.
          if (row.status === cond.not) return false;
        } else if (cond && typeof cond === 'object' && Array.isArray(cond.in)) {
          if (!cond.in.includes(row.status)) return false;
        } else {
          throw new Error(`unhandled status condition: ${JSON.stringify(cond)}`);
        }
        break;
      default:
        throw new Error(`the where-evaluator does not understand key \`${key}\``);
    }
  }
  return true;
}

// 🔴 THE CANONICAL SHARED DB MOCK, not a per-file registration of `~/server/db/client` — a
// per-file mock of a canonical specifier freezes this file's shape into every later file in
// the same worker under `--no-isolate`, which `no-direct-shared-module-mock` enforces.
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockDbRead = dbMock.dbRead;

const { mockGetAppViews } = vi.hoisted(() => ({ mockGetAppViews: vi.fn() }));
vi.mock('../app-views.service', async (importOriginal) => {
  const actual = await importOriginal<typeof AppViewsService>();
  return { ...actual, getAppViews: (...args: unknown[]) => mockGetAppViews(...args) };
});

// 🔴 THIS SHIM CAPTURES THE INTERPOLATED VALUES. The series read's exclusion is a PARAMETER,
// not static text, so a shim that drops values cannot tell a correctly-parameterised
// predicate from one bound to the wrong constant — which is exactly the mistake that would
// leave the read unfiltered in prod while the test stayed green.
vi.mock('@prisma/client', () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      __sql: strings.join('?'),
      __values: values,
    }),
    join: (values: unknown[]) => ({ __join: values }),
  },
}));

import { getMyAppAnalytics } from '../app-analytics.service';

/** `date_trunc('day', ts)` — the bucket key the real statement groups by. */
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

function wireMocks() {
  mockDbRead.appBlock.findMany.mockResolvedValue([
    { id: OWNED_ID, manifest: { page: { path: '/' } } },
    { id: OWNED_ID_2, manifest: { page: { path: '/' } } },
  ]);
  mockDbRead.appCollaborator.findFirst.mockResolvedValue(null);
  mockDbRead.appCollaborator.findMany.mockResolvedValue([]);
  // Reads not under test. They must still return a SHAPE the service can read, or the
  // failure would look like a filter bug.
  mockDbRead.blockUserSubscription.count.mockResolvedValue(0);
  mockDbRead.blockBuzzAttribution.aggregate.mockResolvedValue({ _count: 0, _sum: {} });
  mockDbRead.blockScopeInvocation.count.mockResolvedValue(0);
  mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([]);
  mockGetAppViews.mockResolvedValue({ count: 0, uniqueViewers: 0, anonCount: 0 });

  // READ 1 — the Prisma aggregate behind `runs.count` and `runs.buzzSpent`.
  mockDbRead.blockSpendAttribution.aggregate.mockImplementation(async ({ where }: any) => {
    const visible = rows.filter((r) => matches(r, where));
    return {
      _count: visible.length,
      _sum: { buzzAmount: visible.reduce((n, r) => n + r.buzzAmount, 0) },
    };
  });

  // READ 2 — the raw per-bucket series behind `runs.series`.
  mockDbRead.$queryRaw.mockImplementation(async (arg: any) => {
    const sql: string = arg?.__sql ?? '';
    if (!sql.includes('block_spend_attribution')) return [];
    // 🔴 THE OWNERSHIP BOUND IS READ FROM THE STATEMENT'S OWN JOINED IDS, not hardcoded, so
    // the foreign-app row is a real control on the scope rather than a row nobody counted.
    const joined = (arg.__values as unknown[]).find(
      (v): v is { __join: unknown[] } =>
        typeof v === 'object' && v !== null && Array.isArray((v as { __join?: unknown }).__join)
    );
    const ownedIds = (joined?.__join ?? []) as string[];
    // 🔴 BOUND BY POSITION, NOT "the first string in the list". `__sql` joins the template's
    // static parts with `?`, so a value's parameter index is the number of `?` preceding it.
    // Reading "the first string" would be right only until another string interpolation is
    // added ahead of it — and `date_trunc(${truncUnit}, …)` already is one.
    const paramAt = (needle: string): unknown => {
      const at = sql.indexOf(needle);
      if (at === -1) return undefined;
      return (arg.__values as unknown[])[sql.slice(0, at + needle.length).split('?').length - 1];
    };
    // 🔴 THE BOUNDS COME OFF THE STATEMENT TOO, not from module constants. A shim that
    // reimplements the statement measures the shim: asserting the range with the values the
    // TEST chose would leave DELETING both `AND "attributed_at"` lines green.
    const gte = paramAt('"attributed_at" >= ') as Date | undefined;
    const lte = paramAt('"attributed_at" <= ') as Date | undefined;
    const excludedStatus = paramAt('"status" <> ');
    const visible = rows.filter(
      (r) =>
        ownedIds.includes(r.appBlockId) &&
        (gte === undefined || r.attributedAt >= gte) &&
        (lte === undefined || r.attributedAt <= lte) &&
        (excludedStatus === undefined || r.status !== excludedStatus)
    );
    const tally = new Map<string, number>();
    for (const r of visible)
      tally.set(dayKey(r.attributedAt), (tally.get(dayKey(r.attributedAt)) ?? 0) + 1);
    return [...tally.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, value]) => ({
        bucket: new Date(`${bucket}T00:00:00Z`),
        value: BigInt(value),
      }));
  });
}

beforeEach(() => {
  // 🔴 CALL HISTORY MUST BE CLEARED PER TEST. `resetSharedMocks()` runs once per FILE.
  // `mockClear` rather than `mockReset`: reset would wipe the shared node's registered
  // default, which only the setup file re-applies.
  mockDbRead.$queryRaw.mockClear();
  mockDbRead.blockSpendAttribution.aggregate.mockClear();
  mockGetAppViews.mockReset();
  wireMocks();
});

/**
 * 🔴 DELIBERATELY NO `appBlockId`. `getOwnedAppBlocks` narrows the owned set to a single
 * requested id (`owned.filter((a) => a.id === appBlockId)`), so passing one would put
 * `OWNED_ID_2` out of scope and collapse `IN (ownedIds)` to a single-element list — leaving
 * the multi-id path, and the foreign-app control that depends on it, unexercised.
 */
const analytics = () =>
  getMyAppAnalytics({
    userId: OWNER_ID,
    from: RANGE_FROM,
    to: RANGE_TO,
  });

const seriesValues = (a: Awaited<ReturnType<typeof analytics>>) =>
  a.runs.series.map((p) => p.value);

/**
 * 🔴 TWO CASES ON THE EVALUATOR ITSELF, AND ONLY TWO. An earlier revision had eight,
 * modelling every Prisma spelling equivalent to the exclusion. Six of them are gone: no
 * code emits those spellings, so the branches they covered were reachable ONLY from these
 * tests, and the justification offered for them — "so a future refactor does not SILENTLY
 * turn this file's assertions vacuous" — was wrong about the failure mode. A mishandled
 * spelling produced a LOUD misleading red, never a silent green; the evaluator's own
 * comments record that measurement. Tests whose payoff is a nicer error message for a
 * refactor nobody has performed are speculative generality, and they were expensive: two
 * of this change's four review rounds spent their findings inside that dead scaffolding.
 *
 * What survives is the one mechanism that genuinely made a case vacuous, plus the contract
 * that keeps the rest honest. Both assert BEHAVIOUR, never the evaluator's source text.
 */
describe('[INV] the where-evaluator evaluates allowlist shapes instead of throwing', () => {
  const tracked = { ...TRACKED_A };
  const scoped = (cond: unknown) => ({
    appBlockId: { in: [OWNED_ID, OWNED_ID_2] },
    attributedAt: { gte: RANGE_FROM, lte: RANGE_TO },
    ...(cond as Record<string, unknown>),
  });

  it('an allowlist spelling is evaluated, not thrown on — so a mutant dies on an assertion', () => {
    // 🔴 THE ONE MEASURED VACUITY THIS FILE EVER HAD. While the evaluator threw here, the
    // allowlist mutant died on a `TypeError` from the harness rather than on the denylist
    // case's assertion — so that case measured the predicate's SHAPE, not its consequence.
    expect(matches(tracked, scoped({ status: 'tracked' }))).toBe(true);
    expect(matches({ ...TRACKED_A, status: 'held' }, scoped({ status: 'tracked' }))).toBe(false);
  });

  it('a shape it does not model throws rather than silently passing', () => {
    // The contract every exclusion assertion in this file rests on: an unmodelled shape
    // must fail loudly, never be treated as "no constraint". `startsWith` is a real Prisma
    // operator deliberately not modelled; a top-level `NOT:` is a correct spelling that is
    // also deliberately not modelled, so a refactor to it reddens here instead of quietly
    // dropping the exclusion.
    expect(() => matches(tracked, scoped({ status: { startsWith: 'void' } }))).toThrow();
    expect(() => matches(tracked, scoped({ NOT: { status: VOIDED } }))).toThrow();
  });
});

describe('owner-visible run analytics exclude voided attribution rows', () => {
  it('[INV] the evaluator sees the fixture at all (instrument control)', async () => {
    // 🔴 THE POSITIVE CONTROL FOR THE HARNESS. Every exclusion assertion below says a number
    // went DOWN; a harness returning zeros would satisfy all of them while measuring
    // nothing. This run has NO voided row, so these are the owner's true numbers and every
    // later figure is read against them.
    rows = [...SURVIVING];
    const a = await analytics();
    expect(a.runs.count).toBe(7);
    expect(a.runs.buzzSpent).toBe(179);
    expect(seriesValues(a)).toEqual([1, 1, 1, 2, 1, 1]);
  });

  it('[REG] a run with NOTHING but voided rows reports zero, not the void total', async () => {
    // The mirror of the control above: proves the aggregate is actually reading the predicate
    // rather than returning `rows.length`.
    rows = [...VOIDED_ROWS];
    const a = await analytics();
    expect(a.runs.count).toBe(0);
    expect(a.runs.buzzSpent).toBe(0);
    expect(seriesValues(a)).toEqual([]);
  });

  it('[REG] voided rows change NONE of the three run numbers', async () => {
    // The whole property in one case: adding every voided row to the table must leave the
    // owner's `runs` byte-identical to the control.
    rows = [...SURVIVING];
    const before = (await analytics()).runs;
    rows = [...SURVIVING, ...VOIDED_ROWS];
    const after = (await analytics()).runs;
    // Asserted field-by-field BEFORE the whole-object compare: a bare `toEqual` on the
    // object prints `{count: 5, buzzSpent: 89, …(1)} to deeply equal {count: 5, …(1)}`
    // when only the elided `series` key differs, which is unreadable precisely in the
    // series-only-leak case.
    expect(after.count).toBe(before.count);
    expect(after.buzzSpent).toBe(before.buzzSpent);
    expect(after.series).toEqual(before.series);
    expect(after).toEqual(before);
  });

  it('[REG] a manual_review-voided row is not counted and its Buzz is not summed', async () => {
    // 🔴 CALLED OUT SEPARATELY BECAUSE ITS DAY COLLIDES with a surviving row's, so a
    // bucket-level leak is visible rather than appended.
    //
    // ⚠️ NAMED "a private run (voided/manual_review)" until the write-side change. A
    // private run writes no row now, and NOTHING ELSE writes this value to this table
    // either — see the fixture's own docblock above, which retracts the two producers an
    // earlier correction claimed (historical private runs; `backpay.service.ts`, which
    // writes a different table with `status: 'held'`). 🔴 THIS COMMENT ASSERTED BOTH OF
    // THEM 330 LINES BELOW THE DOCBLOCK THAT RETRACTED THEM, so the file contradicted
    // itself; a sweep that stops at the site you were editing is how that happens.
    // The assertion is unchanged and still correct: it pins that the denylist keys on
    // `status`, whatever the `voidedReason`.
    rows = [...SURVIVING, VOIDED_REVIEW_G];
    const a = await analytics();
    expect(a.runs.count).toBe(7);
    expect(a.runs.buzzSpent).toBe(179);
    expect(seriesValues(a)).toEqual([1, 1, 1, 2, 1, 1]);
  });

  it('[INV] confirmed and paid_out rows SURVIVE — the filter is a denylist, not an allowlist', async () => {
    // 🔴 LABELLED [INV] BECAUSE IT WAS GREEN AT THE PRE-CHANGE REF, and saying otherwise
    // would be claiming regression coverage this case does not provide. Before the filter
    // existed nothing was excluded, so these rows survived trivially — the invariant it pins
    // is a FUTURE one: it can only ever go red if someone narrows the predicate to an
    // allowlist. `status: 'tracked'` is the obvious simplification a reader reaches for, and
    // it IS caught (measured, not assumed).
    //
    // ⚠️ IT IS NOT CAUGHT *ONLY* HERE, and an earlier revision of this comment claimed it
    // was. Measured: the allowlist mutant fails this case AND every other case whose fixture
    // contains a payout-rail status — which is most of them, because `SURVIVING` deliberately
    // holds `confirmed` and `paid_out` rows. The broad kill is better for safety and worse
    // for diagnosis; what this case adds is a NAME for the property, so the failure says
    // "denylist" instead of an unexplained off-by-two in five other cases.
    rows = [CONFIRMED_C, PAID_OUT_D, PENDING_K, HELD_L];
    const a = await analytics();
    expect(a.runs.count).toBe(4);
    expect(a.runs.buzzSpent).toBe(120);
    expect(seriesValues(a)).toEqual([1, 1, 1, 1]);
  });

  it('[REG] every non-voided status survives together, with the full table loaded', async () => {
    // The realistic shape: the whole fixture, including the rows no read may return.
    rows = [...ALL_ROWS];
    const a = await analytics();
    expect(a.runs.count).toBe(7);
    expect(a.runs.buzzSpent).toBe(179);
    expect(seriesValues(a)).toEqual([1, 1, 1, 2, 1, 1]);
  });

  it("[INV] the ownership bound still applies — a foreign app's non-voided row never appears", async () => {
    rows = [...SURVIVING, FOREIGN_H];
    const a = await analytics();
    expect(a.runs.count).toBe(7);
    expect(a.runs.buzzSpent).toBe(179);
    // 🔴 THE SERIES ASSERTION IS THE POINT OF THIS LINE. Without it this case speaks only
    // for the Prisma aggregate's ownership bound and says nothing about the raw
    // statement's, while its NAME claims the property outright. Measured: deleting both
    // `AND "attributed_at"` lines from the series statement left this case GREEN and was
    // caught only incidentally by the full-table case.
    expect(seriesValues(a)).toEqual([1, 1, 1, 2, 1, 1]);
  });

  it('[INV] the range bound still applies — an out-of-range non-voided row never appears', async () => {
    rows = [...SURVIVING, OUT_OF_RANGE_I];
    const a = await analytics();
    expect(a.runs.count).toBe(7);
    expect(a.runs.buzzSpent).toBe(179);
    // Same reasoning as the ownership case above: the raw statement has its own range
    // bound and this is what speaks for it.
    expect(seriesValues(a)).toEqual([1, 1, 1, 2, 1, 1]);
  });
});
