import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppViewsService from '../app-views.service';

/**
 * 🔴 DOES A PRIVATE RUN ACTUALLY DISAPPEAR FROM THE OWNER'S ANALYTICS — AND DOES AN
 * ORDINARY USER'S ACTIVITY ACTUALLY SURVIVE?
 *
 * Both questions, because the two failure directions are not symmetric in cost:
 *   · UNDER-filtering leaks review activity to the owner of a delisted app. That is the
 *     bug, and it is at least loud once someone looks.
 *   · OVER-filtering silently deletes the owner's REAL usage data from their own dashboard.
 *     That is worse — nobody reports numbers they never saw.
 * So every assertion here comes in a pair, and the ORDINARY half is the positive control
 * without which the excluded half is indistinguishable from a filter wired to nothing.
 *
 * ── WHY THIS IS NOT A `where`-SHAPE TEST ────────────────────────────────────────
 * 🔴 ASSERTING THE `where` OBJECT WOULD BE DERIVING THE EXPECTATION FROM THE
 * IMPLEMENTATION. `expect(where).toMatchObject({ source: { not: 'private-run' } })` passes
 * whether or not that predicate excludes anything, and it cannot see the ONE read that
 * matters most — the raw `count(DISTINCT "user_id")`, which has no `where` object at all.
 *
 * Instead the Prisma mock here is a tiny in-memory EVALUATOR: it applies the service's real
 * `where` to a fixture row set and returns real counts. The structural claim (the filter is
 * spread at every read) is the sibling guard's job
 * (`server/services/__tests__/no-unmarked-private-run-invocation.test.ts`); this file
 * measures the consequence.
 */

type Row = {
  appBlockId: string;
  userId: number;
  scope: string;
  endpoint: string;
  statusCode: number;
  source: string;
  invokedAt: Date;
};

const OWNER_ID = 4242;
const OWNED_ID = 'apb_analytics_fixture';
/** A SECOND owned app, so the raw read's `IN (ownedIds)` is exercised rather than assumed. */
const OWNED_ID_2 = 'apb_analytics_fixture_2';
/**
 * 🔴 AN APP THE CALLER DOES NOT OWN, with a row in range. The raw `count(DISTINCT user_id)`
 * statement's ownership bound was HARDCODED in the shim as `r.appBlockId === OWNED_ID`, so
 * nothing measured it — and swapping that statement's leading `AND` for an `OR` survived the
 * whole suite while making one owner's `activeUsers` every distinct user of every app in the
 * table. This row is what turns that from a substring claim into a measurement.
 */
const FOREIGN_ID = 'apb_someone_elses_app';
const FOREIGN_VIEWER = 51001;
const MODERATOR_ID = 77001;
const VIEWER_A = 31337;
const VIEWER_B = 31338;
const IN_RANGE = new Date('2026-06-10T12:00:00Z');
const RANGE_FROM = new Date('2026-06-01T00:00:00Z');
const RANGE_TO = new Date('2026-06-20T00:00:00Z');

/** The marker value, re-declared here ONLY so a wrong constant in the service is visible. */
const MARKER = 'private-run';

/**
 * Three ordinary rows from TWO distinct viewers plus one private-run row from a third user.
 * Every count in the assertions differs from every other, and no fixture value equals a
 * constant an assertion names — so a mutant that hardcodes a number moves the output rather
 * than coincidentally matching it.
 *
 * The private-run row is deliberately a `500` on a scope and endpoint that ALSO appear on
 * ordinary rows: that is what makes the top-5 rollups and the error rate discriminating
 * rather than trivially separable, and it is the realistic shape (a moderator exercising
 * the same generation path a user would).
 */
const ORDINARY_ROWS: Row[] = [
  {
    appBlockId: OWNED_ID,
    userId: VIEWER_A,
    scope: 'ai:write:budgeted',
    endpoint: 'workflow:submit',
    statusCode: 200,
    source: 'app-block',
    invokedAt: IN_RANGE,
  },
  {
    appBlockId: OWNED_ID,
    userId: VIEWER_A,
    scope: 'ai:write:budgeted',
    endpoint: 'workflow:submit',
    statusCode: 500,
    source: 'app-block',
    invokedAt: IN_RANGE,
  },
  {
    appBlockId: OWNED_ID,
    userId: VIEWER_B,
    scope: 'apps:storage:read',
    endpoint: 'storage:get',
    statusCode: 200,
    source: 'app-block',
    invokedAt: IN_RANGE,
  },
];

const PRIVATE_RUN_ROW: Row = {
  appBlockId: OWNED_ID,
  userId: MODERATOR_ID,
  scope: 'ai:write:budgeted',
  endpoint: 'workflow:submit',
  statusCode: 500,
  source: MARKER,
  invokedAt: IN_RANGE,
};

/** The same row with the marker removed — the over-filtering positive control. */
const UNMARKED_TWIN: Row = { ...PRIVATE_RUN_ROW, source: 'app-block' };

let rows: Row[] = [];

/**
 * Evaluate the subset of Prisma `where` the service actually uses against a row. Kept
 * deliberately literal: anything the service starts using that this does not understand
 * shows up as an unhandled key rather than being silently ignored.
 */
function matches(row: Row, where: Record<string, any>): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    switch (key) {
      case 'appBlockId':
        if (!cond.in.includes(row.appBlockId)) return false;
        break;
      case 'invokedAt':
        if (row.invokedAt < cond.gte || row.invokedAt > cond.lte) return false;
        break;
      case 'statusCode':
        if (!(row.statusCode >= cond.gte)) return false;
        break;
      case 'source':
        // The only shape the exclusion uses. A different shape must fail loudly rather
        // than be treated as "no constraint", which would make every case below vacuous.
        if (!('not' in cond))
          throw new Error(`unhandled source condition: ${JSON.stringify(cond)}`);
        if (row.source === cond.not) return false;
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
// ⚠️ That guard is TEXTUAL, so it fires on the phrase as well as the call: do not write the
// forbidden registration out longhand here, even inside a comment explaining why not to.
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockDbRead = dbMock.dbRead;

// ⚠️ The module type is imported at the top rather than written as a `typeof import(...)`
// ANNOTATION: `@typescript-eslint/consistent-type-imports` is an ERROR in this repo and
// forbids the inline form. The sibling analytics suite still uses it only because the lint
// job runs over CHANGED files, so an unchanged file never trips it.
const { mockGetAppViews } = vi.hoisted(() => ({ mockGetAppViews: vi.fn() }));
vi.mock('../app-views.service', async (importOriginal) => {
  const actual = await importOriginal<typeof AppViewsService>();
  return { ...actual, getAppViews: (...args: unknown[]) => mockGetAppViews(...args) };
});

// 🔴 THIS SHIM CAPTURES THE INTERPOLATED VALUES, unlike the one in the sibling suite. The
// distinct-user read's exclusion is a PARAMETER, not static text, so a shim that drops
// values cannot tell a correctly-parameterised predicate from one bound to the wrong
// constant — which is exactly the mistake that would leave the read unfiltered in prod
// while the test stayed green.
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

function wireMocks() {
  mockDbRead.appBlock.findMany.mockResolvedValue([
    { id: OWNED_ID, manifest: { page: { path: '/' } } },
  ]);
  // Seat lookups resolve to "no collaborators"; the shared mock's own defaults already return
  // null/[] for these shapes, but they are declared so the fixture states its own
  // preconditions rather than depending on a default table elsewhere.
  mockDbRead.appCollaborator.findFirst.mockResolvedValue(null);
  mockDbRead.appCollaborator.findMany.mockResolvedValue([]);
  // The three non-invocation aggregates are not under test here. They must still return a
  // SHAPE the service can read — `runsAgg._count` on an `undefined` would throw before any
  // engagement assertion ran, and the failure would look like a filter bug.
  mockDbRead.blockUserSubscription.count.mockResolvedValue(0);
  mockDbRead.blockSpendAttribution.aggregate.mockResolvedValue({ _count: 0, _sum: {} });
  mockDbRead.blockBuzzAttribution.aggregate.mockResolvedValue({ _count: 0, _sum: {} });
  mockGetAppViews.mockResolvedValue({ count: 0, uniqueViewers: 0, anonCount: 0 });

  mockDbRead.blockScopeInvocation.count.mockImplementation(
    async ({ where }: any) => rows.filter((r) => matches(r, where)).length
  );

  mockDbRead.blockScopeInvocation.groupBy.mockImplementation(async ({ by, where }: any) => {
    const key = by[0] as 'scope' | 'endpoint';
    const tally = new Map<string, number>();
    for (const r of rows.filter((x) => matches(x, where))) {
      tally.set(r[key], (tally.get(r[key]) ?? 0) + 1);
    }
    return [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([v, n]) => ({ [key]: v, _count: n }));
  });

  mockDbRead.$queryRaw.mockImplementation(async (arg: any) => {
    const sql: string = arg?.__sql ?? '';
    if (!sql.includes('block_scope_invocations')) return [];
    // 🔴 THE OWNERSHIP BOUND IS READ FROM THE STATEMENT'S OWN JOINED IDS, not hardcoded.
    // The `Prisma.join(ownedIds)` shim yields `{ __join: [...] }`, so the ids the service
    // actually restricted to are recoverable — which is what lets the foreign-app row below
    // be a real control on the scope rather than a row nobody ever counted.
    const joined = (arg.__values as unknown[]).find(
      (v): v is { __join: unknown[] } =>
        typeof v === 'object' && v !== null && Array.isArray((v as { __join?: unknown }).__join)
    );
    const ownedIds = (joined?.__join ?? []) as string[];
    // Mirror the real statement: always range-bounded and app-bounded; exclude a `source`
    // value ONLY when the statement actually names one, and only the value it binds.
    // 🔴 BOUND BY POSITION, NOT "the first string in the list". The shim's `__sql` joins
    // the template's static parts with `?`, so the parameter index of any interpolated value
    // is the number of `?` that precede it — and reading "the first string" happened to be
    // right only because no other string interpolation preceded it. One added ahead of it and
    // the shim would silently use the wrong value while still looking correct.
    const paramAt = (needle: string): unknown => {
      const at = sql.indexOf(needle);
      if (at === -1) return undefined;
      return (arg.__values as unknown[])[sql.slice(0, at + needle.length).split('?').length - 1];
    };
    const excluded = paramAt('"source" <> ');
    // 🔴 AND THE RANGE BOUNDS COME OFF THE STATEMENT TOO, not from module constants. The
    // previous shim asserted `r.invokedAt >= RANGE_FROM && <= RANGE_TO` using the values the
    // TEST chose — so DELETING both `AND "invoked_at"` lines from the real statement left the
    // suite green, under a case whose own comment said "the range bound must still apply".
    // A shim that reimplements a statement measures the shim.
    const gte = paramAt('"invoked_at" >= ') as Date | undefined;
    const lte = paramAt('"invoked_at" <= ') as Date | undefined;
    // 🔴 NO NEGATION HANDLING HERE, DELIBERATELY, AND THE DELETION IS THE POINT.
    //
    // A previous revision detected `/NOT\s+IN\s*\(/i` and inverted this membership test, so
    // that an inverted ownership bound would show up behaviourally. Two measurements retired
    // it. First, the branch was UNREACHED: deleting it failed exactly one test — the one
    // written to exercise it — and that test drove this shim DIRECTLY with a hand-built SQL
    // string, so zero lines of `app-analytics.service.ts` ran. It was a test of the test, and
    // its `[INV]` label was honest only because it could never go red on any production
    // revert. Second, it keyed off the SAME regex the structural guard used, so it was never
    // a second opinion: a structural guard and a behavioural guard testing one predicate are
    // ONE guard, which is exactly how `WHERE NOT "app_block_id" IN (…)` walked both at once.
    //
    // The ownership bound's shape is now pinned where it can actually be enforced — as an
    // exact match on the whole normalised statement, in
    // `services/__tests__/no-unmarked-private-run-invocation.test.ts`. That fails on ANY
    // negation spelling, so no real statement can reach this shim negated.
    const inSet = (id: string) => ownedIds.includes(id);
    const visible = rows.filter(
      (r) =>
        inSet(r.appBlockId) &&
        (gte === undefined || r.invokedAt >= gte) &&
        (lte === undefined || r.invokedAt <= lte) &&
        (excluded === undefined || r.source !== excluded)
    );
    return [{ value: BigInt(new Set(visible.map((r) => r.userId)).size) }];
  });
}

beforeEach(() => {
  // 🔴 CALL HISTORY MUST BE CLEARED PER TEST. `resetSharedMocks()` runs once per FILE, so
  // without this the `$queryRaw` call inspected by the last case below could be one issued
  // by an earlier case. `mockClear` rather than `mockReset`: reset would wipe the shared
  // node's registered default, which only the setup file re-applies.
  mockDbRead.$queryRaw.mockClear();
  mockDbRead.blockScopeInvocation.count.mockClear();
  mockDbRead.blockScopeInvocation.groupBy.mockClear();
  mockGetAppViews.mockReset();
  wireMocks();
});

const analytics = () =>
  getMyAppAnalytics({
    appBlockId: OWNED_ID,
    userId: OWNER_ID,
    from: RANGE_FROM,
    to: RANGE_TO,
  });

describe('owner-visible engagement analytics exclude private-run activity', () => {
  it('[INV] the evaluator sees the fixture at all (instrument control)', async () => {
    // 🔴 THE POSITIVE CONTROL FOR THE HARNESS. Every exclusion assertion below is a
    // statement that a number went DOWN; a harness returning zeros would satisfy all of
    // them while measuring nothing. This is the run with NO private-run row at all, so the
    // numbers here are the owner's true activity and every later figure is read against it.
    rows = [...ORDINARY_ROWS];
    const a = await analytics();
    expect(a.engagement.apiCalls).toBe(3);
    expect(a.engagement.activeUsers).toBe(2);
    expect(a.engagement.errorRate).toBeCloseTo(1 / 3, 10);
    expect(a.engagement.topScopes).toEqual([
      { scope: 'ai:write:budgeted', count: 2 },
      { scope: 'apps:storage:read', count: 1 },
    ]);
    expect(a.engagement.topEndpoints).toEqual([
      { endpoint: 'workflow:submit', count: 2 },
      { endpoint: 'storage:get', count: 1 },
    ]);
  });

  it('[REG] a private-run row changes NONE of the five engagement numbers', async () => {
    // The whole property in one case: adding the moderator's row to the table must leave
    // the owner's dashboard byte-identical to the control above.
    rows = [...ORDINARY_ROWS];
    const before = (await analytics()).engagement;
    rows = [...ORDINARY_ROWS, PRIVATE_RUN_ROW];
    const after = (await analytics()).engagement;
    expect(after).toEqual(before);
  });

  it('[REG] the count(DISTINCT user_id) read does not count the reviewer', async () => {
    // 🔴 CALLED OUT SEPARATELY BECAUSE IT IS THE READ THAT NAMES A PERSON. `activeUsers`
    // is a distinct-user count, so an unfiltered private run does not merely inflate a
    // total — it adds ONE to a small number on the exact day review happened, which is the
    // signal the feature exists to withhold. It is also the only read with no `where`
    // object, so it is the one a structural check cannot see.
    rows = [...ORDINARY_ROWS, PRIVATE_RUN_ROW];
    expect((await analytics()).engagement.activeUsers).toBe(2);
  });

  it('[INV] POSITIVE CONTROL — the SAME row unmarked is counted, in all five numbers', async () => {
    // 🔴 FEED A VALUE THE FILTER MUST NOT MATCH AND WATCH THE COUNT MOVE. Without this,
    // every assertion above is satisfied by a filter that excludes everything — and that
    // filter would silently delete the owner's real usage data. The twin differs from the
    // private-run row in ONE field.
    //
    // ⚠️ [INV], NOT [REG], AND THE CORRECTION MATTERS. This was labelled [REG] until a
    // review lane ran it with every production file reverted to the base ref and found it
    // GREEN — correctly, because an unfiltered read counts the unmarked twin too. It is a
    // control, and a control that cannot go red at base is an invariant. Labelling it [REG]
    // launders the segment's ONLY over-filter control into the regression count, which is
    // the exact error the sibling ledger's own docblock names.
    rows = [...ORDINARY_ROWS, UNMARKED_TWIN];
    const a = await analytics();
    expect(a.engagement.apiCalls).toBe(4);
    expect(a.engagement.activeUsers).toBe(3);
    expect(a.engagement.errorRate).toBeCloseTo(2 / 4, 10);
    expect(a.engagement.topScopes).toEqual([
      { scope: 'ai:write:budgeted', count: 3 },
      { scope: 'apps:storage:read', count: 1 },
    ]);
    expect(a.engagement.topEndpoints).toEqual([
      { endpoint: 'workflow:submit', count: 3 },
      { endpoint: 'storage:get', count: 1 },
    ]);
  });

  it('[REG] the error-rate NUMERATOR excludes a private-run failure', async () => {
    // Isolated from the case above because the error rate is a RATIO: if the filter were
    // applied to the numerator only, or to the denominator only, the total-count assertion
    // would still pass while the published rate was wrong. Here the private run is the
    // ONLY 5xx, so an unfiltered numerator is unmissable.
    rows = [ORDINARY_ROWS[0], ORDINARY_ROWS[2], PRIVATE_RUN_ROW];
    const a = await analytics();
    expect(a.engagement.apiCalls).toBe(2);
    expect(a.engagement.errorRate).toBe(0);
    // Control: the same shape with the marker removed publishes a non-zero error rate (one
    // 5xx over three calls), so the zero above is a measurement rather than a harness that
    // cannot produce a non-zero.
    rows = [ORDINARY_ROWS[0], ORDINARY_ROWS[2], UNMARKED_TWIN];
    expect((await analytics()).engagement.errorRate).toBeCloseTo(1 / 3, 10);
  });

  it('[REG] a scope reached ONLY by a private run does not appear in topScopes at all', async () => {
    // The disclosure is not just a count: a scope the app has never been used for, showing
    // up in the owner's top-5 on one day, names the review as clearly as a user count does.
    const probeScope = 'collections:read:private';
    rows = [...ORDINARY_ROWS, { ...PRIVATE_RUN_ROW, scope: probeScope }];
    const a = await analytics();
    expect(a.engagement.topScopes.map((s) => s.scope)).not.toContain(probeScope);
    // Control: unmarked, that scope DOES surface — so the absence above is the filter.
    rows = [...ORDINARY_ROWS, { ...UNMARKED_TWIN, scope: probeScope }];
    expect((await analytics()).engagement.topScopes.map((s) => s.scope)).toContain(probeScope);
  });

  it('[REG] a private-run-only app reports a truthful ZERO, not a leak', async () => {
    // The realistic first case in production: a delisted app whose ONLY recent activity is
    // the review of it. Every engagement number must be zero — and `errorRate` must be 0
    // rather than NaN, because `apiCalls` is 0 and a NaN would render as a broken panel
    // that itself signals something happened.
    rows = [PRIVATE_RUN_ROW];
    const a = await analytics();
    expect(a.engagement.apiCalls).toBe(0);
    expect(a.engagement.activeUsers).toBe(0);
    expect(a.engagement.errorRate).toBe(0);
    expect(Number.isNaN(a.engagement.errorRate)).toBe(false);
    expect(a.engagement.topScopes).toEqual([]);
    expect(a.engagement.topEndpoints).toEqual([]);
    // 🔴 AND IT MUST NOT READ AS "unavailable" OR "notOwned" — a discriminator flipping on
    // the day of a review is itself a disclosure. A filtered-to-empty app must be
    // indistinguishable from an app with genuinely no activity.
    expect(a.notOwned).toBe(false);
  });

  it("[INV] the distinct-user read counts only the OWNER'S apps, in range", async () => {
    // ⚠️ [INV], MEASURED — green with `app-analytics.service.ts` reverted to the base ref,
    // because the ownership and range bounds PREDATE this change. It was labelled [REG] on
    // the strength of "it is a new case", which is the laundering error this file corrected
    // in four other places; a label belongs to the PROPERTY, not to when the case was added.
    // What IS new is that anything measures those bounds at all: three cross-tenant mutants
    // survived the whole suite while the test shim reimplemented the statement instead of
    // reading it.
    // 🔴 THE CONTROL FOR THE WORST MUTANT IN THIS SEGMENT. Swapping the raw statement's
    // leading `AND` for an `OR` leaves the source predicate's TEXT intact, and Postgres
    // precedence then makes the ownership and range restriction OPTIONAL — one owner's
    // `activeUsers` becomes every distinct user of every app in the table. Cross-tenant, i.e.
    // strictly worse than the leak this PR closes. It survived the whole suite while the
    // shim HARDCODED the ownership bound as `appBlockId === OWNED_ID`; the shim now reads
    // the ids the statement actually joined, so these rows are a real control on the scope.
    rows = [
      ...ORDINARY_ROWS,
      // An app the caller does not own at all.
      { ...ORDINARY_ROWS[0], appBlockId: FOREIGN_ID, userId: FOREIGN_VIEWER },
      // Out of range on the requested app: the range bound must still apply.
      { ...ORDINARY_ROWS[0], userId: 51002, invokedAt: new Date('2026-05-01T00:00:00Z') },
    ];
    const a = await analytics();
    // The two distinct viewers on the requested app, and nothing else.
    expect(a.engagement.activeUsers).toBe(2);
    // 🔴 AND THE FOUR PRISMA READS TOO, WHICH HAD NO OWNERSHIP ASSERTION AT ALL. Removing
    // `appBlockId: idIn` from all four of them turns `apiCalls`, the error rate and both
    // top-5 rollups into totals over the WHOLE table, and that survived the entire suite —
    // this fixture already contained the foreign-app row that catches it, and only
    // `activeUsers` was ever read off it. Three ordinary rows on the requested app; the
    // foreign row and the out-of-range row must contribute to none of these.
    expect(a.engagement.apiCalls).toBe(3);
    expect(a.engagement.topScopes.map((s) => s.count).reduce((x, y) => x + y, 0)).toBe(3);
    expect(a.engagement.topEndpoints.map((s) => s.count).reduce((x, y) => x + y, 0)).toBe(3);
  });

  it('[INV] the distinct-user read spans EVERY app the caller owns, not just one', async () => {
    // ⚠️ [INV] for the same reason as the case above: the `IN (ownedIds)` set is pre-existing
    // behaviour. Measured green with `app-analytics.service.ts` reverted to the base ref.
    // The other half of the same bound, and the reason `OWNED_ID_2` exists: the statement
    // restricts to `IN (ownedIds)`, so a shim comparing against a single id would pass a
    // mutant that narrowed the join. Called with no `appBlockId`, so the owned SET is used.
    mockDbRead.appBlock.findMany.mockResolvedValue([
      { id: OWNED_ID, manifest: { page: { path: '/' } } },
      { id: OWNED_ID_2, manifest: { page: { path: '/' } } },
    ]);
    rows = [
      ...ORDINARY_ROWS,
      { ...ORDINARY_ROWS[0], appBlockId: OWNED_ID_2, userId: 51003 },
      { ...ORDINARY_ROWS[0], appBlockId: FOREIGN_ID, userId: FOREIGN_VIEWER },
    ];
    const a = await getMyAppAnalytics({ userId: OWNER_ID, from: RANGE_FROM, to: RANGE_TO });
    // Both owned apps' viewers, and not the foreign one.
    expect(a.engagement.activeUsers).toBe(3);
  });

  it('[REG] the distinct-user exclusion is bound to the MARKER, not to some other value', async () => {
    // 🔴 A PARAMETERISED PREDICATE CAN BE CORRECTLY SHAPED AND BOUND TO THE WRONG CONSTANT,
    // and that reads as a working filter until a private-run row exists. The evaluator
    // above excludes whatever value the statement actually binds, so binding
    // `'app-block'` by mistake would exclude the ORDINARY rows and this case would fail
    // with 1 instead of 2.
    rows = [...ORDINARY_ROWS, PRIVATE_RUN_ROW];
    await analytics();
    const call = mockDbRead.$queryRaw.mock.calls
      .map((c) => c[0] as any)
      .find((a) => (a?.__sql ?? '').includes('block_scope_invocations'));
    expect(call, 'the distinct-user statement must have been issued').toBeTruthy();
    expect(call.__sql).toContain('"source" <> ');
    expect(call.__values).toContain(MARKER);
    expect(call.__values).not.toContain('app-block');
  });
});
