import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allFindings,
  freshDb,
  pgliteKysely,
  seedFinding,
  seedRun,
} from './abuse-detection-pglite.harness';

/**
 * `recordAbuseVerdict` and `getAbuseVerdictSummary`, EXECUTED against a real Postgres.
 *
 * 🔴 WHY NOT THE FAKE-BUILDER TIER. Every guard in `recordAbuseVerdict` is a statement about WHICH
 * ROWS MOVE: a group ruling must reach every member of the cluster in this run, and must not reach
 * the identical cluster key in yesterday's run, or an ungrouped sibling, or the producer's own
 * `actioned` column. A fake builder can only be asked what it was told — it has no rows, so it
 * cannot distinguish a correctly scoped UPDATE from one scoped to the whole table. That is exactly
 * the weakness `abuse-detection.test.ts` documents about the read chains, and it applies with more
 * force to a write.
 *
 * The `sql.test.ts` tier still pins the compiled statement text; this one pins the effect.
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

/** Two runs of the same detector, so "the same group key in another run" is a real row, not a hypothesis. */
const STARTED_TODAY = '2026-09-03T03:20:00Z';
const STARTED_YESTERDAY = '2026-09-02T03:20:00Z';
const RING = 'domain:ring.test';

beforeEach(async () => {
  db = await freshDb();
  dbHandle.current = pgliteKysely(db);
});

afterEach(async () => {
  vi.useRealTimers();
  dbHandle.current = null;
  await db.close();
});

/** The shape almost every case needs: a ring of three today, the same ring yesterday, and strays. */
async function seedTwoRuns() {
  const today = await seedRun(db, 'bot-account-detection', STARTED_TODAY);
  const yesterday = await seedRun(db, 'bot-account-detection', STARTED_YESTERDAY);
  const ids = {
    today,
    yesterday,
    ringToday: [
      await seedFinding(db, { runId: today, userId: 11, groupKey: RING }),
      await seedFinding(db, { runId: today, userId: 12, groupKey: RING }),
      await seedFinding(db, { runId: today, userId: 13, groupKey: RING }),
    ],
    // Same run, a DIFFERENT cluster — must not move with the ring above.
    otherGroupToday: await seedFinding(db, {
      runId: today,
      userId: 14,
      groupKey: 'domain:other.test',
    }),
    // Same run, NO cluster. Two of them, because "NULL is not a group" is only observable when
    // there is a second NULL row that could wrongly be swept up with the first.
    loneToday: await seedFinding(db, { runId: today, userId: 15 }),
    otherLoneToday: await seedFinding(db, { runId: today, userId: 16 }),
    // 🔴 THE SAME CLUSTER KEY IN ANOTHER RUN. A ring reappears in the next day's cohort under the
    // identical key; ruling today must not rule yesterday.
    ringYesterday: await seedFinding(db, { runId: yesterday, userId: 11, groupKey: RING }),
  };
  return ids;
}

const ruledIds = async () =>
  (await allFindings(db)).filter((r) => r.verdict !== null).map((r) => r.id);

describe('recordAbuseVerdict — which rows move', () => {
  it('rules exactly ONE finding when it carries no group key', async () => {
    const ids = await seedTwoRuns();
    const out = await service.recordAbuseVerdict({
      runId: ids.today,
      findingId: ids.loneToday,
      verdict: 'fp',
      verdictBy: 'mod-a',
    });

    expect(out).toEqual({ updated: 1, groupKey: null });
    // 🔴 The OTHER null-group finding in the same run is untouched. A NULL group key used as a match
    // value would rule both, and the count above would still read as a plausible number.
    expect(await ruledIds()).toEqual([ids.loneToday]);
  });

  it('rules every member of a cluster, in this run, with one click', async () => {
    const ids = await seedTwoRuns();
    const out = await service.recordAbuseVerdict({
      runId: ids.today,
      findingId: ids.ringToday[0],
      verdict: 'tp',
      verdictBy: 'mod-a',
    });

    expect(out).toEqual({ updated: 3, groupKey: RING });
    expect(await ruledIds()).toEqual([...ids.ringToday].sort((a, b) => a - b));
  });

  it('🔴 does NOT reach the same cluster key in a DIFFERENT run', async () => {
    // The expensive mistake this guard exists for. The same ring reappears in tomorrow's cohort
    // under the identical key, so an UPDATE matching only `group_key` rules every day that ring has
    // ever been seen — from one page, on one day's evidence, with nothing on screen saying so.
    const ids = await seedTwoRuns();
    await service.recordAbuseVerdict({
      runId: ids.today,
      findingId: ids.ringToday[0],
      verdict: 'tp',
      verdictBy: 'mod-a',
    });

    const rows = await allFindings(db);
    const yesterdayRow = rows.find((r) => r.id === ids.ringYesterday);
    expect(yesterdayRow?.group_key, 'the fixture must actually share the key').toBe(RING);
    expect(yesterdayRow?.run_id).toBe(ids.yesterday);
    expect(yesterdayRow?.verdict, 'yesterday’s run was ruled by a click on today’s').toBeNull();
    expect(yesterdayRow?.verdict_by).toBeNull();
  });

  it('does not reach a different cluster, or an ungrouped finding, in the same run', async () => {
    const ids = await seedTwoRuns();
    await service.recordAbuseVerdict({
      runId: ids.today,
      findingId: ids.ringToday[0],
      verdict: 'tp',
      verdictBy: 'mod-a',
    });

    const rows = await allFindings(db);
    for (const id of [ids.otherGroupToday, ids.loneToday, ids.otherLoneToday])
      expect(rows.find((r) => r.id === id)?.verdict).toBeNull();
  });

  it('refuses a finding that belongs to another run, and writes nothing', async () => {
    // The finding id arrives in a form post and is therefore attacker-chosen. Without the run bound,
    // a post from today's page rules a row on yesterday's.
    const ids = await seedTwoRuns();
    const out = await service.recordAbuseVerdict({
      runId: ids.today,
      findingId: ids.ringYesterday,
      verdict: 'tp',
      verdictBy: 'mod-a',
    });

    expect(out).toEqual({ updated: 0, groupKey: null });
    expect(await ruledIds()).toEqual([]);
  });

  it('refuses a finding id that does not exist at all', async () => {
    const ids = await seedTwoRuns();
    await expect(
      service.recordAbuseVerdict({
        runId: ids.today,
        findingId: 999_999,
        verdict: 'tp',
        verdictBy: 'mod-a',
      })
    ).resolves.toEqual({ updated: 0, groupKey: null });
  });
});

describe('recordAbuseVerdict — what it writes', () => {
  it('stores the verdict, the moderator and the time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    const ids = await seedTwoRuns();

    await service.recordAbuseVerdict({
      runId: ids.today,
      findingId: ids.loneToday,
      verdict: 'skip',
      verdictBy: 'mod-a',
    });

    const row = (await allFindings(db)).find((r) => r.id === ids.loneToday);
    // Literal expectations throughout — none of them read back from the implementation.
    expect(row?.verdict).toBe('skip');
    expect(row?.verdict_by).toBe('mod-a');
    expect(new Date(row?.verdict_at as Date).toISOString()).toBe('2026-09-04T10:00:00.000Z');
  });

  it('a re-ruling OVERWRITES, and the record names the current ruler', async () => {
    // A moderator correcting a mistake must stand behind the correction, not the mistake. A write
    // that only filled NULLs — or an INSERT-shaped one — would leave the first ruler's name on a
    // verdict they did not give.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    const ids = await seedTwoRuns();

    await service.recordAbuseVerdict({
      runId: ids.today,
      findingId: ids.loneToday,
      verdict: 'tp',
      verdictBy: 'mod-a',
    });

    vi.setSystemTime(new Date('2026-09-04T11:30:00.000Z'));
    const out = await service.recordAbuseVerdict({
      runId: ids.today,
      findingId: ids.loneToday,
      verdict: 'fp',
      verdictBy: 'mod-b',
    });

    expect(out.updated).toBe(1);
    const row = (await allFindings(db)).find((r) => r.id === ids.loneToday);
    expect(row?.verdict).toBe('fp');
    expect(row?.verdict_by).toBe('mod-b');
    expect(new Date(row?.verdict_at as Date).toISOString()).toBe('2026-09-04T11:30:00.000Z');
    // Still one row, not a second one appended.
    expect(await ruledIds()).toEqual([ids.loneToday]);
  });

  it('🔴 leaves the producer’s `actioned` and `action` exactly as they were', async () => {
    // The conflation regression, through the SERVICE rather than raw SQL — the schema test asserts
    // the database permits it, this asserts the code does it. `actioned: true, action: 'exclude'`
    // ruled `fp` is the interesting row: the detector acted, and a human says it should not have.
    // Losing the record of the action loses the only evidence of what actually happened.
    const runId = await seedRun(db, 'bot-account-detection', STARTED_TODAY);
    const id = await seedFinding(db, {
      runId,
      userId: 21,
      actioned: true,
      action: 'exclude',
      groupKey: RING,
    });
    const sibling = await seedFinding(db, { runId, userId: 22, groupKey: RING });

    await service.recordAbuseVerdict({ runId, findingId: id, verdict: 'fp', verdictBy: 'mod-a' });

    const rows = await allFindings(db);
    expect(rows.find((r) => r.id === id)).toMatchObject({
      actioned: true,
      action: 'exclude',
      verdict: 'fp',
    });
    // And the group member the ruling reached keeps ITS producer record too.
    expect(rows.find((r) => r.id === sibling)).toMatchObject({
      actioned: false,
      action: null,
      verdict: 'fp',
    });
  });
});

describe('getAbuseVerdictSummary', () => {
  it('counts the whole run, ruled and unruled', async () => {
    const ids = await seedTwoRuns();
    // Six findings today; rule the three-member ring.
    await service.recordAbuseVerdict({
      runId: ids.today,
      findingId: ids.ringToday[0],
      verdict: 'tp',
      verdictBy: 'mod-a',
    });

    // Literal numbers, from the fixture's own shape: 6 findings today, 3 of them ruled.
    await expect(service.getAbuseVerdictSummary(ids.today)).resolves.toEqual({
      ruled: 3,
      unruled: 3,
    });
    // The other run is unaffected, which is what makes the scoping above visible in the count too.
    await expect(service.getAbuseVerdictSummary(ids.yesterday)).resolves.toEqual({
      ruled: 0,
      unruled: 1,
    });
  });

  it('reports zeroes for a run with no findings, not null', async () => {
    // `null` means "this deployment cannot record a ruling". A clean run must not borrow that state.
    const runId = await seedRun(db, 'review-bomb', STARTED_TODAY);
    await expect(service.getAbuseVerdictSummary(runId)).resolves.toEqual({ ruled: 0, unruled: 0 });
  });
});

describe('the findings read carries the ruling', () => {
  it('returns the verdict, the ruler and the group key', async () => {
    const ids = await seedTwoRuns();
    await service.recordAbuseVerdict({
      runId: ids.today,
      findingId: ids.ringToday[0],
      verdict: 'tp',
      verdictBy: 'mod-a',
    });

    const { findings } = await service.getAbuseFindings(ids.today);
    const ruled = findings.find((f) => f.id === ids.ringToday[0]);
    expect(ruled).toMatchObject({ verdict: 'tp', verdictBy: 'mod-a', groupKey: RING });
    expect(ruled?.verdictAt).toBeInstanceOf(Date);
    // An unruled row reports nulls rather than being omitted — the board renders it with buttons.
    expect(findings.find((f) => f.id === ids.loneToday)).toMatchObject({
      verdict: null,
      verdictBy: null,
      verdictAt: null,
      groupKey: null,
    });
  });
});

describe('recordAbuseRun stores the producer’s group key', () => {
  const report = (groupKey?: string | null) => ({
    detector: 'bot-account-detection',
    startedAt: '2026-09-05T03:20:00.000Z',
    finishedAt: '2026-09-05T03:20:41.000Z',
    findings: [
      { userId: 31, confidence: 0.4, reason: 'in a ring', actioned: false, groupKey },
      { userId: 32, confidence: 0.4, reason: 'alone', actioned: false },
    ],
  });

  it('writes the key it was given, and NULL where it was given none', async () => {
    await service.recordAbuseRun(report(RING));
    const rows = await allFindings(db);
    expect(rows.map((r) => [r.user_id, r.group_key])).toEqual([
      [31, RING],
      [32, null],
    ]);
  });

  it('accepts a report from a producer that sends no group key at all', async () => {
    // Three detectors already post to this board and none of them sends the field. A required key
    // would 400 every one of their reports.
    await service.recordAbuseRun(report());
    expect((await allFindings(db)).map((r) => r.group_key)).toEqual([null, null]);
  });

  it('treats an explicit null the same as an absent key', async () => {
    await service.recordAbuseRun(report(null));
    expect((await allFindings(db)).map((r) => r.group_key)).toEqual([null, null]);
  });
});

/**
 * 🔴 THE PRE-DDL WINDOW, BUILT BY DROPPING THE COLUMNS.
 *
 * The DDL is applied by hand, so between this merging and someone running it the tables exist and
 * these four columns do not. Dropping them reproduces that table EXACTLY — same rows, same producer
 * columns, same indexes — and the errors that come back are the real `42703` from a real server, not
 * a hand-thrown stand-in that could have the wrong code on it.
 */
describe('a deployment whose DDL has not been applied', () => {
  beforeEach(async () => {
    await db.exec(`ALTER TABLE abuse_detection_finding
      DROP COLUMN verdict, DROP COLUMN verdict_by, DROP COLUMN verdict_at, DROP COLUMN group_key;`);
  });

  it('the board still reads its findings', async () => {
    const runId = await seedRun(db, 'review-bomb', STARTED_TODAY);
    await seedFindingLegacy(runId, 41);

    const { findings } = await service.getAbuseFindings(runId);
    expect(findings).toHaveLength(1);
    // Reported as unruled, which is the truthful reading: nothing has been ruled here, and nothing
    // can be. A thrown error would take the page down for a database serving every row it holds.
    expect(findings[0]).toMatchObject({ verdict: null, verdictBy: null, groupKey: null });
  });

  it('the run header still reads', async () => {
    const runId = await seedRun(db, 'review-bomb', STARTED_TODAY);
    await seedFindingLegacy(runId, 41);
    await expect(service.getAbuseRun(runId)).resolves.toMatchObject({ findingCount: 1 });
  });

  it('the verdict summary answers null rather than throwing', async () => {
    const runId = await seedRun(db, 'review-bomb', STARTED_TODAY);
    await expect(service.getAbuseVerdictSummary(runId)).resolves.toBeNull();
  });

  it('🔴 a WRITE is refused, with a message naming the file to run', async () => {
    // A write must not degrade. Silently accepting a ruling that was never stored, and rendering it
    // as recorded, is the one outcome worse than refusing it.
    const runId = await seedRun(db, 'review-bomb', STARTED_TODAY);
    const findingId = await seedFindingLegacy(runId, 41);
    await expect(
      service.recordAbuseVerdict({ runId, findingId, verdict: 'tp', verdictBy: 'mod-a' })
    ).rejects.toThrow(/schema\.sql/);
  });

  it('🔴 the detectors keep reporting — a run lands, UNGROUPED', async () => {
    // The ingest path must not be taken down by a column that was added for a feature. Three
    // detectors post here; two of them do not use grouping at all.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      service.recordAbuseRun({
        detector: 'bot-account-detection',
        startedAt: '2026-09-05T03:20:00.000Z',
        finishedAt: '2026-09-05T03:20:41.000Z',
        findings: [
          { userId: 31, confidence: 0.4, reason: 'in a ring', actioned: false, groupKey: RING },
        ],
      })
    ).resolves.toMatchObject({ runId: expect.any(Number) });

    const rows = await db.query<{ user_id: number }>(
      `SELECT user_id FROM abuse_detection_finding ORDER BY id`
    );
    expect(rows.rows.map((r) => r.user_id)).toEqual([31]);
    // Announced, not silent: "my ring did not collapse into one row" is otherwise an unexplainable
    // UI bug, and the warning names the file that fixes it.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('schema.sql'));
  });
});

/** A findings row without the four columns — the only shape that table has before the DDL is run. */
async function seedFindingLegacy(runId: number, userId: number): Promise<number> {
  const res = await db.query<{ id: number }>(
    `INSERT INTO abuse_detection_finding (run_id, user_id, confidence, reason, actioned)
     VALUES ($1, $2, 0.5, 'seeded', false) RETURNING id`,
    [runId, userId]
  );
  return Number(res.rows[0].id);
}
