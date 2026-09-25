import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshDb, pgliteKysely, seedFinding, seedRun } from './abuse-detection-pglite.harness';

/**
 * `getAbuseRuns` and the REVIEWED count it reports, EXECUTED against a real Postgres.
 *
 * 🔴 WHAT THE COLUMN IS FOR. The list already showed "Findings" and "Acted on", and "Acted on" is
 * the DETECTOR's own self-report — permanently "0 of N" for a detector running in shadow mode. So a
 * board of many runs said nothing at all about which of them a human had been through, which is the
 * one question somebody opening it is asking.
 *
 * 🔴 WHY IT IS A SECOND QUERY, and why that is asserted here rather than left to a comment. It is
 * the only read behind the list page that names `verdict`, and the DDL carrying `verdict` is applied
 * BY HAND. Folded into the list query, a deployment in that window would take a `42703` on the read
 * the whole page is, and `routes/abuse/+page.server.ts` would report a database it is reading from
 * perfectly well as `unreachable`. The last block drops the column and pins that the list still
 * reads.
 *
 * Fixtures use pairwise-distinct run ids, user ids and counts, so no assertion can pass by two
 * values coinciding.
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../moderator-db', () => ({
  getModeratorDb: () => {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    // `withTables` is a TYPE-level operation that returns the same client.
    return Object.assign(dbHandle.current as object, { withTables: () => dbHandle.current });
  },
}));

const service = await import('../abuse-detection.service');

let db: PGlite;

const STARTED_TODAY = '2026-09-03T03:20:00Z';
const STARTED_YESTERDAY = '2026-09-02T03:20:00Z';

beforeEach(async () => {
  db = await freshDb();
  dbHandle.current = pgliteKysely(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  dbHandle.current = null;
  await db.close();
});

const rule = (findingId: number, verdict = 'tp') =>
  db.query(`UPDATE abuse_detection_finding SET verdict = $1, verdict_by = '77' WHERE id = $2`, [
    verdict,
    findingId,
  ]);

/** The list, keyed by run id — the shape every assertion below reads. */
async function listByRun() {
  const runs = await service.getAbuseRuns();
  return new Map(runs.map((r) => [r.id, r]));
}

describe('getAbuseRuns reports how much of each run has been reviewed', () => {
  it('counts the ruled findings of each run, separately', async () => {
    const today = await seedRun(db, 'bot-account-detection', STARTED_TODAY);
    const yesterday = await seedRun(db, 'bot-account-detection', STARTED_YESTERDAY);

    // Three findings today, two of them ruled. One yesterday, ruled.
    await rule(await seedFinding(db, { runId: today, userId: 11 }));
    await rule(await seedFinding(db, { runId: today, userId: 12 }), 'fp');
    await seedFinding(db, { runId: today, userId: 13 });
    await rule(await seedFinding(db, { runId: yesterday, userId: 14 }), 'skip');

    const list = await listByRun();
    expect(list.get(today)).toMatchObject({ findingCount: 3, ruledCount: 2 });
    // 🔴 PER RUN. A count that leaked across runs would read 3 here, and would look entirely
    // plausible on a board where the same detector reports every day.
    expect(list.get(yesterday)).toMatchObject({ findingCount: 1, ruledCount: 1 });
  });

  it('every verdict counts as reviewed, including an abstention', async () => {
    // `skip` is a DECISION — "I looked and I am not calling it" — and the whole point of the column
    // is which runs still need a human. Counting only tp/fp would send one back to a run that is done.
    const runId = await seedRun(db, 'review-bomb', STARTED_TODAY);
    await rule(await seedFinding(db, { runId, userId: 21 }), 'skip');
    expect((await listByRun()).get(runId)).toMatchObject({ findingCount: 1, ruledCount: 1 });
  });

  it('reports ZERO for a run nobody has opened — not null, and not absent', async () => {
    // A run with no ruled findings produces no row in the grouped count. Resolving that absence to
    // `null` would render an em dash and read as "this cannot be answered" on a board where it can.
    const runId = await seedRun(db, 'review-bomb', STARTED_TODAY);
    await seedFinding(db, { runId, userId: 31 });
    await seedFinding(db, { runId, userId: 32 });
    expect((await listByRun()).get(runId)).toMatchObject({ findingCount: 2, ruledCount: 0 });
  });

  it('reports zero for a run with no findings at all', async () => {
    const runId = await seedRun(db, 'review-bomb', STARTED_TODAY);
    expect((await listByRun()).get(runId)).toMatchObject({ findingCount: 0, ruledCount: 0 });
  });

  it('leaves the detector’s own figures alone', async () => {
    // 🔴 THE TWO COLUMNS ARE INDEPENDENT AND THE BOARD SAYS SO. The commonest finding is one the
    // detector left alone and a moderator ruled correct; a reviewed count that moved `actionedCount`
    // would erase the only record of what the detector chose to do.
    const runId = await seedRun(db, 'bot-account-detection', STARTED_TODAY);
    await rule(await seedFinding(db, { runId, userId: 41, actioned: false }));
    await seedFinding(db, { runId, userId: 42, actioned: true, action: 'flagged' });

    expect((await listByRun()).get(runId)).toMatchObject({
      findingCount: 2,
      actionedCount: 1,
      ruledCount: 1,
    });
  });

  it('answers for an empty board without building an `in ()`', async () => {
    // No runs means no ids to ask about, and an empty `IN ()` is a syntax error rather than an empty
    // result. The list must come back empty, not throw.
    await expect(service.getAbuseRuns()).resolves.toEqual([]);
  });

  it('counts only the runs the filter returned', async () => {
    // The count query is scoped to the ids the list query produced. Without that scoping a detector
    // filter would still pay for every run in the table.
    const bots = await seedRun(db, 'bot-account-detection', STARTED_TODAY);
    const bombs = await seedRun(db, 'review-bomb', STARTED_YESTERDAY);
    await rule(await seedFinding(db, { runId: bots, userId: 51 }));
    await rule(await seedFinding(db, { runId: bombs, userId: 52 }));

    const filtered = await service.getAbuseRuns({ detector: 'review-bomb' });
    expect(filtered.map((r) => r.id)).toEqual([bombs]);
    expect(filtered[0].ruledCount).toBe(1);
  });
});

describe('a deployment whose verdict columns are not applied', () => {
  beforeEach(async () => {
    await db.exec(`ALTER TABLE abuse_detection_finding
      DROP COLUMN verdict, DROP COLUMN verdict_by, DROP COLUMN verdict_at, DROP COLUMN group_key;`);
  });

  it('🔴 still lists every run, rather than taking the page down', async () => {
    // The whole reason the count is a second query. A `42703` on the list read would surface in
    // `+page.server.ts` as `unreachable` — an operator sent hunting an outage on a healthy database.
    const runId = await seedRun(db, 'review-bomb', STARTED_TODAY);
    await db.query(
      `INSERT INTO abuse_detection_finding (run_id, user_id, confidence, reason, actioned)
       VALUES ($1, 61, 0.7, 'seeded', false)`,
      [runId]
    );

    const runs = await service.getAbuseRuns();
    expect(runs.map((r) => r.id)).toEqual([runId]);
    expect(runs[0]).toMatchObject({ detector: 'review-bomb', findingCount: 1 });
  });

  it('🔴 reports the reviewed count as null, NOT as zero', async () => {
    // Opposite claims. Zero says nobody has looked yet and someone should; null says no ruling can
    // exist here at all, and the page renders an em dash rather than a backlog to work through.
    const runId = await seedRun(db, 'review-bomb', STARTED_TODAY);
    const runs = await service.getAbuseRuns();
    expect(runs.find((r) => r.id === runId)?.ruledCount).toBeNull();
  });
});

/**
 * 🔴 A `42703` IS NOT AUTOMATICALLY "THE DDL IS NOT APPLIED".
 *
 * Both verdict reads name `id` and `run_id` alongside `verdict`, and the bare error CODE cannot say
 * which one the server complained about. Read as the DDL window, a board broken in one of those
 * answers `null` — the list renders an em dash under "Reviewed" and the run page goes read-only,
 * with nothing anywhere reporting a fault. That is a silent wrong answer where an error belongs.
 *
 * The write paths already discriminate on the column NAME; these two now do the same. An unreadable
 * name still degrades, because the name is parsed out of an ENGLISH message and a non-English
 * `lc_messages` would otherwise take the board down where it used to degrade.
 */
describe('a 42703 that is not about `verdict`', () => {
  const pgError = (message: string) => Object.assign(new Error(message), { code: '42703' });

  /**
   * A client that answers the RUN table from the real database and fails only on the FINDING table.
   *
   * 🔴 THE DISCRIMINATION IS THE WHOLE TEST. Failing every statement would make `getAbuseRuns` throw
   * on its list query — which has always propagated — so the case would pass without the count query
   * ever running. The positive control below feeds the same stub a `verdict` error and watches the
   * answer degrade, which is what proves this reaches `ruledCountsByRun` at all.
   */
  const failOnFindings = (e: unknown) => {
    const real = pgliteKysely(db);
    const stub = {
      withTables: () => stub,
      selectFrom: (table: string) => {
        if (String(table).startsWith('abuse_detection_finding')) throw e;
        return (real as unknown as { selectFrom: (t: string) => unknown }).selectFrom(table);
      },
    };
    dbHandle.current = stub;
  };

  it('🔴 propagates from the reviewed count, rather than reporting the board unreviewed', async () => {
    await seedRun(db, 'review-bomb', STARTED_TODAY);
    failOnFindings(pgError('column "run_id" does not exist'));
    await expect(service.getAbuseRuns()).rejects.toMatchObject({ code: '42703' });
  });

  it('positive control — the same stub degrades when the error names `verdict`', async () => {
    // Without this the case above is indistinguishable from a stub that never reached the count
    // query: both end in a rejection, one for the reason claimed and one for the wrong reason.
    await seedRun(db, 'review-bomb', STARTED_TODAY);
    failOnFindings(pgError('column "verdict" does not exist'));
    const runs = await service.getAbuseRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].ruledCount).toBeNull();
  });

  it('🔴 propagates from the run summary, rather than reporting the run unruleable', async () => {
    failOnFindings(pgError('column "id" does not exist'));
    await expect(service.getAbuseVerdictSummary(1)).rejects.toMatchObject({ code: '42703' });
  });

  it.each([
    ['names `verdict`', 'column "verdict" does not exist'],
    // A server whose messages are not English. Degrading is the safe direction for a READ — the
    // alternative turns the degradation OFF wherever `lc_messages` is not English, taking the board
    // down in the one window it exists to survive.
    ['cannot be parsed at all', 'Spalte »verdict« existiert nicht'],
  ])('the run summary still degrades when the error %s', async (_label, message) => {
    failOnFindings(pgError(message));
    await expect(service.getAbuseVerdictSummary(1)).resolves.toBeNull();
  });
});

/**
 * 🔴 AN ERROR THAT IS NOT A MISSING COLUMN AT ALL.
 *
 * This block exists because the guard separating the two — `isMissingVerdictColumn`'s opening
 * `isUndefinedColumnError` check — was UNREACHABLE by the entire suite. Deleting that one line left
 * 79 files and 1149 tests green, measured.
 *
 * The mutant is not a near-miss. `missingColumnFromError` re-reads the pg code itself and answers
 * `null` for TWO different reasons — "not a 42703" and "a 42703 whose message I could not parse" —
 * and the line after the guard treats `null` as the second. So without it a connection drop, a lock
 * timeout or a TypeError out of the query builder makes BOTH reads answer "no ruling can exist
 * here": the run page goes read-only under a notice telling an operator to apply a DDL that is
 * already applied, and the list renders an em dash under Reviewed. A broken board reporting itself
 * as a deployment state is strictly worse than the 503 it replaced.
 *
 * The line reads as removable precisely because its callee re-checks the code, which is what makes
 * it worth a test rather than a comment: a comment is what a tidy-up reads past.
 */
describe('an error that is not a missing column', () => {
  /** Fails every statement — what a dropped connection or an exhausted pool actually does. */
  const failEverything = (e: unknown) => {
    const stub = {
      withTables: () => stub,
      selectFrom: () => {
        throw e;
      },
    };
    dbHandle.current = stub;
  };

  const CONNECTION_DROP = () =>
    Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });
  const LOCK_TIMEOUT = () =>
    Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
  /** No pg code at all — a fault from the driver or the builder rather than from the server. */
  const BUILDER_FAULT = () => new TypeError("cannot read properties of undefined (reading 'ref')");

  it('positive control — this harness DOES degrade for a real missing `verdict`', async () => {
    // Run FIRST and asserted on its own, because without it every rejection below is equally well
    // explained by a stub that fails before anything under test runs. One error apart, the same
    // harness produces the opposite answer, which is what attributes those rejections to the error
    // KIND rather than to the plumbing.
    failEverything(Object.assign(new Error('column "verdict" does not exist'), { code: '42703' }));
    await expect(service.getAbuseVerdictSummary(1)).resolves.toBeNull();
  });

  it.each([
    ['a connection drop', CONNECTION_DROP],
    ['a lock timeout', LOCK_TIMEOUT],
    ['a builder fault carrying no pg code', BUILDER_FAULT],
  ])('%s propagates out of the run summary, never reads as a missing DDL', async (_label, make) => {
    failEverything(make());
    // `rejects` alone would pass for a rejection with any value; the board's whole failure mode here
    // is answering `null` INSTEAD of throwing, so the identity of what comes back is the assertion.
    await expect(service.getAbuseVerdictSummary(1)).rejects.toThrow(make().message);
  });

  it('🔴 a 42501 propagates too — it is a GRANT problem, not a missing DDL', async () => {
    // The one surviving mutant of this guard, closed. Widening its code predicate to accept
    // `PG_INSUFFICIENT_PRIVILEGE` as well left all 158 abuse tests green — and that constant is
    // declared in this very file, a few lines above, which is what makes the edit a realistic one
    // rather than a contrived one.
    //
    // Rethrowing is what the two page loads are built for: both already discriminate `42501` into
    // their own branch, which names the actual remedy (re-run schema.sql AS THE APPLICATION ROLE —
    // the `psql -U postgres` shortcut leaves tables the app can read but does not own). Degrading
    // instead would answer "apply the verdict DDL" for a board whose DDL is applied and whose role
    // simply cannot read it, sending an operator at the wrong file.
    failEverything(
      Object.assign(new Error('permission denied for table abuse_detection_finding'), {
        code: '42501',
      })
    );
    await expect(service.getAbuseVerdictSummary(1)).rejects.toThrow('permission denied for table');
  });

  it.each([
    ['a connection drop', CONNECTION_DROP],
    ['a builder fault carrying no pg code', BUILDER_FAULT],
  ])('%s propagates out of the reviewed count', async (_label, make) => {
    // Through the FINDING table only, so the list query still answers from the real database and the
    // count is genuinely the statement under test — the same discrimination the block above needs.
    await seedRun(db, 'review-bomb', STARTED_TODAY);
    const real = pgliteKysely(db);
    const stub = {
      withTables: () => stub,
      selectFrom: (table: string) => {
        if (String(table).startsWith('abuse_detection_finding')) throw make();
        return (real as unknown as { selectFrom: (t: string) => unknown }).selectFrom(table);
      },
    };
    dbHandle.current = stub;
    await expect(service.getAbuseRuns()).rejects.toThrow(make().message);
  });
});
