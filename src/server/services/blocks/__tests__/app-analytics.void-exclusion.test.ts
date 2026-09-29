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
 * silent-deletion failure as the nullability trap, arriving later. The `confirmed` and
 * `paid_out` fixture rows below are what make that a measurement — an allowlist mutant
 * passes every other case in this file and dies only on them.
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
 * 🔴 EVERY BUZZ VALUE IS DISTINCT, AND NO FIXTURE VALUE EQUALS ANY TOTAL AN ASSERTION NAMES
 * (fixtures 7/11/13/17/19/23/29/31/37/41 vs totals 89/160/71). A fixture that can only ever
 * produce the asserted constant's own value cannot see a mutant that hardcodes the literal,
 * so it would SURVIVE a fully green suite.
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
/** THE PRIVATE RUN. `manual_review` is the reason a private-run generation is voided with. */
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

/** Owned, in range, and NOT voided: 5 rows, 89 Buzz. */
const SURVIVING = [TRACKED_A, TRACKED_B, CONFIRMED_C, PAID_OUT_D, TRACKED_J];
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
        // The only shape the exclusion uses. A different shape must fail loudly rather than
        // be treated as "no constraint".
        if (!('not' in cond))
          throw new Error(`unhandled status condition: ${JSON.stringify(cond)}`);
        if (row.status === cond.not) return false;
        break;
      case 'NOT':
        // The alternative top-level spelling. Supported so that switching to it is a
        // refactor rather than a silent test failure — but only for `status`.
        if (!('status' in cond))
          throw new Error(`unhandled NOT condition: ${JSON.stringify(cond)}`);
        if (row.status === cond.status) return false;
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
    for (const r of visible) tally.set(dayKey(r.attributedAt), (tally.get(dayKey(r.attributedAt)) ?? 0) + 1);
    return [...tally.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, value]) => ({ bucket: new Date(`${bucket}T00:00:00Z`), value: BigInt(value) }));
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

const seriesValues = (a: Awaited<ReturnType<typeof analytics>>) => a.runs.series.map((p) => p.value);

describe('owner-visible run analytics exclude voided attribution rows', () => {
  it('[INV] the evaluator sees the fixture at all (instrument control)', async () => {
    // 🔴 THE POSITIVE CONTROL FOR THE HARNESS. Every exclusion assertion below says a number
    // went DOWN; a harness returning zeros would satisfy all of them while measuring
    // nothing. This run has NO voided row, so these are the owner's true numbers and every
    // later figure is read against them.
    rows = [...SURVIVING];
    const a = await analytics();
    expect(a.runs.count).toBe(5);
    expect(a.runs.buzzSpent).toBe(89);
    expect(seriesValues(a)).toEqual([1, 1, 1, 2]);
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
    expect(after).toEqual(before);
  });

  it('[REG] a private run (voided/manual_review) is not counted and its Buzz is not summed', async () => {
    // 🔴 CALLED OUT SEPARATELY BECAUSE IT IS THE ROW THE FEATURE EXISTS FOR. Its day collides
    // with a surviving row's, so a bucket-level leak is visible rather than appended.
    rows = [...SURVIVING, VOIDED_REVIEW_G];
    const a = await analytics();
    expect(a.runs.count).toBe(5);
    expect(a.runs.buzzSpent).toBe(89);
    expect(seriesValues(a)).toEqual([1, 1, 1, 2]);
  });

  it('[REG] the pre-existing self_spend void population is not counted either', async () => {
    rows = [...SURVIVING, VOIDED_SELF_E, VOIDED_SELF_F];
    const a = await analytics();
    expect(a.runs.count).toBe(5);
    expect(a.runs.buzzSpent).toBe(89);
  });

  it('[INV] confirmed and paid_out rows SURVIVE — the filter is a denylist, not an allowlist', async () => {
    // 🔴 LABELLED [INV] BECAUSE IT WAS GREEN AT THE PRE-CHANGE REF, and saying otherwise
    // would be claiming regression coverage this case does not provide. Before the filter
    // existed nothing was excluded, so these rows survived trivially — the invariant it pins
    // is a FUTURE one: it can only ever go red if someone narrows the predicate to an
    // allowlist. That is not a hypothetical spelling; `status: 'tracked'` is the obvious
    // simplification a reader reaches for, it passes every other case in this file, and it
    // dies only here — verified by mutation, not assumed.
    rows = [CONFIRMED_C, PAID_OUT_D];
    const a = await analytics();
    expect(a.runs.count).toBe(2);
    expect(a.runs.buzzSpent).toBe(30);
    expect(seriesValues(a)).toEqual([1, 1]);
  });

  it('[REG] every non-voided status survives together, with the full table loaded', async () => {
    // The realistic shape: the whole fixture, including the rows no read may return.
    rows = [...ALL_ROWS];
    const a = await analytics();
    expect(a.runs.count).toBe(5);
    expect(a.runs.buzzSpent).toBe(89);
    expect(seriesValues(a)).toEqual([1, 1, 1, 2]);
  });

  it('[INV] the ownership bound still applies — a foreign app\'s non-voided row never appears', async () => {
    rows = [...SURVIVING, FOREIGN_H];
    const a = await analytics();
    expect(a.runs.count).toBe(5);
    expect(a.runs.buzzSpent).toBe(89);
  });

  it('[INV] the range bound still applies — an out-of-range non-voided row never appears', async () => {
    rows = [...SURVIVING, OUT_OF_RANGE_I];
    const a = await analytics();
    expect(a.runs.count).toBe(5);
    expect(a.runs.buzzSpent).toBe(89);
  });

  it('[REG] the raw series statement binds the excluded status as a PARAMETER', async () => {
    // 🔴 NOT a source-text assertion: it reads the values the statement actually bound, via
    // the same positional decoder the shim uses. A predicate spelled against the wrong
    // constant (or inlined as literal text, so nothing is bound) fails here.
    rows = [...ALL_ROWS];
    await analytics();
    const call = mockDbRead.$queryRaw.mock.calls
      .map(([arg]: any[]) => arg)
      .find((arg: any) => String(arg?.__sql ?? '').includes('block_spend_attribution'));
    expect(call).toBeDefined();
    const sql = String(call.__sql);
    const at = sql.indexOf('"status" <> ');
    expect(at).toBeGreaterThan(-1);
    const bound = call.__values[sql.slice(0, at + '"status" <> '.length).split('?').length - 1];
    expect(bound).toBe(VOIDED);
  });
});
