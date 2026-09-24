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
