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
  // 🔴 `vi.spyOn` on an ALREADY-spied method returns the EXISTING spy rather than a fresh one, so
  // without this a `console.warn` spy carries the previous test's calls into the next one. That is
  // not a cosmetic leak: it made `expect(warn).not.toHaveBeenCalled()` fail against code that had
  // warned nothing, and would equally have made it PASS for the wrong reason in the other order.
  vi.restoreAllMocks();
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

/**
 * 🔴 A PRODUCER REPLAY MUST NOT DESTROY A MODERATOR'S RULING.
 *
 * The run upsert is idempotent on `(detector, started_at)`, so a re-POST keeps the SAME run row and
 * the same id — which is the point, and is what makes the retry safe. What used to follow it was
 * `DELETE FROM abuse_detection_finding WHERE run_id = …` and a re-insert from a payload that carries
 * no verdict fields. That was lossless while these rows held only producer-generated data; it stopped
 * being lossless the moment a human judgement went into the same row.
 *
 * Measured on this harness before the fix: rule three findings, re-POST the identical
 * `(detector, startedAt)`, and `getAbuseVerdictSummary` went `{ ruled: 3, unruled: 0 }` →
 * `{ ruled: 0, unruled: 3 }`, with new row ids and no warning of any kind. The replay that does it is
 * the ordinary "committed, response lost to a timeout" retry the upsert's own comment describes.
 *
 * Every case below is asserted on ROWS, not on which function was called: the claim is about what
 * survives a real second write, and only rows can answer that.
 */
describe('🔴 a replay of a run does not destroy its verdicts', () => {
  const REPLAY_STARTED = '2026-09-06T03:20:00.000Z';
  const REPLAY_RING = 'domain:replay-ring.test';

  /** The producer's payload. `omit` drops a member, i.e. the detector stopped flagging that account. */
  const replayReport = (opts: { omit?: number[]; reason?: string } = {}) => ({
    detector: 'bot-account-detection',
    startedAt: REPLAY_STARTED,
    finishedAt: '2026-09-06T03:20:41.000Z',
    findings: [
      { userId: 51, groupKey: REPLAY_RING },
      { userId: 52, groupKey: REPLAY_RING },
      { userId: 53 },
    ]
      .filter((f) => !(opts.omit ?? []).includes(f.userId))
      .map((f) => ({
        confidence: 0.4,
        reason: opts.reason ?? 'as first reported',
        actioned: false,
        ...f,
      })),
  });

  const rowsByUser = async () =>
    Object.fromEntries((await allFindings(db)).map((r) => [r.user_id, r]));

  it('keeps the ruling, the ruler and the row itself across an identical re-POST', async () => {
    const { runId } = await service.recordAbuseRun(replayReport());
    const before = await rowsByUser();
    // One ring member, so the group ruling covers 51 and 52, plus the lone finding.
    await service.recordAbuseVerdict({
      runId,
      findingId: before[51].id,
      verdict: 'tp',
      verdictBy: '77',
    });
    await service.recordAbuseVerdict({
      runId,
      findingId: before[53].id,
      verdict: 'fp',
      verdictBy: '88',
    });
    expect(await service.getAbuseVerdictSummary(runId)).toEqual({ ruled: 3, unruled: 0 });

    const { runId: replayedInto } = await service.recordAbuseRun(replayReport());

    // Same run, by construction — the upsert's whole purpose.
    expect(replayedInto).toBe(runId);
    // 🔴 The literal the old code produced here was `{ ruled: 0, unruled: 3 }`.
    expect(await service.getAbuseVerdictSummary(runId)).toEqual({ ruled: 3, unruled: 0 });

    const after = await rowsByUser();
    expect(after[51]).toMatchObject({ verdict: 'tp', verdict_by: '77' });
    expect(after[52]).toMatchObject({ verdict: 'tp', verdict_by: '77' });
    expect(after[53]).toMatchObject({ verdict: 'fp', verdict_by: '88' });
    // The ROW survived, it was not deleted and re-created with the verdict copied onto a new one.
    // A fresh id would mean the audit timestamp and the row's own history had been re-minted.
    expect([after[51].id, after[52].id, after[53].id]).toEqual([
      before[51].id,
      before[52].id,
      before[53].id,
    ]);
  });

  it('still clears the UNRULED rows, so replaying does not double the findings', async () => {
    // The bug the DELETE exists to prevent, and it must stay prevented: three replays, three rows.
    await service.recordAbuseRun(replayReport());
    await service.recordAbuseRun(replayReport());
    await service.recordAbuseRun(replayReport());
    expect(await allFindings(db)).toHaveLength(3);
  });

  it('does not double them once some of them are ruled, either', async () => {
    const { runId } = await service.recordAbuseRun(replayReport());
    const before = await rowsByUser();
    await service.recordAbuseVerdict({
      runId,
      findingId: before[51].id,
      verdict: 'tp',
      verdictBy: '77',
    });
    // A ruled row is now on the run AND in the payload. Counting survivors per user is what stops
    // it being inserted a second time beside the row it already has.
    await service.recordAbuseRun(replayReport());
    await service.recordAbuseRun(replayReport());
    expect(await allFindings(db)).toHaveLength(3);
    expect((await allFindings(db)).map((r) => r.user_id).sort()).toEqual([51, 52, 53]);
  });

  it('an UNRULED finding the replay no longer reports is dropped', async () => {
    // The producer owns an unruled row outright: it stopped flagging the account, so the row goes.
    await service.recordAbuseRun(replayReport());
    await service.recordAbuseRun(replayReport({ omit: [53] }));
    expect((await allFindings(db)).map((r) => r.user_id)).toEqual([51, 52]);
  });

  it('🔴 a RULED finding the replay no longer reports is KEPT — the decided direction', async () => {
    // Both directions make a claim, and they are not symmetric. Keeping it leaves a row on the run
    // that this payload did not assert — visible on the board, ruled, with its ruler and timestamp,
    // and actionable by a human. Dropping it destroys a judgement silently and unrecoverably, and
    // deflates the denominator of the false-positive rate this board exists to measure: a detector
    // that stopped flagging an account it was told was a false positive would be erasing the
    // evidence of its own error.
    const { runId } = await service.recordAbuseRun(replayReport());
    const before = await rowsByUser();
    await service.recordAbuseVerdict({
      runId,
      findingId: before[53].id,
      verdict: 'fp',
      verdictBy: '88',
    });

    await service.recordAbuseRun(replayReport({ omit: [53] }));

    const after = await rowsByUser();
    expect(Object.keys(after).map(Number).sort()).toEqual([51, 52, 53]);
    expect(after[53]).toMatchObject({ verdict: 'fp', verdict_by: '88' });
    expect(after[53].id).toBe(before[53].id);
    // And it stays kept across further replays rather than surviving exactly one.
    await service.recordAbuseRun(replayReport({ omit: [53] }));
    expect(await allFindings(db)).toHaveLength(3);
  });

  it('a ruled row keeps the evidence it was ruled on, not the replay’s copy', async () => {
    // A moderator ruled on the `reason` that was on screen. Overwriting it with a later copy would
    // leave a verdict attached to evidence nobody ruled on. For a genuine replay the two are the
    // same text anyway — `(detector, started_at)` identifies one run.
    const { runId } = await service.recordAbuseRun(replayReport({ reason: 'the text on screen' }));
    const before = await rowsByUser();
    await service.recordAbuseVerdict({
      runId,
      findingId: before[53].id,
      verdict: 'skip',
      verdictBy: '88',
    });

    await service.recordAbuseRun(replayReport({ reason: 'rewritten afterwards' }));

    const reasons = await db.query<{ user_id: number; reason: string }>(
      `SELECT user_id, reason FROM abuse_detection_finding ORDER BY user_id`
    );
    expect(reasons.rows).toEqual([
      // Unruled: the producer's row, replaced by the producer's newer text.
      { user_id: 51, reason: 'rewritten afterwards' },
      { user_id: 52, reason: 'rewritten afterwards' },
      // Ruled: untouched.
      { user_id: 53, reason: 'the text on screen' },
    ]);
  });

  it('a DIFFERENT run of the same detector is not touched by the replay', async () => {
    // The delete is scoped to one run, and a replay of today must not reach into yesterday — the
    // same scoping mistake the group-ruling guards above are about, on the other write.
    const yesterday = await seedRun(db, 'bot-account-detection', STARTED_YESTERDAY);
    const stray = await seedFinding(db, { runId: yesterday, userId: 51, groupKey: REPLAY_RING });
    await service.recordAbuseRun(replayReport());
    await service.recordAbuseRun(replayReport());
    const rows = await allFindings(db);
    expect(rows.filter((r) => r.run_id === yesterday).map((r) => r.id)).toEqual([stray]);
    expect(rows).toHaveLength(4);
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

/**
 * 🔴 WHAT THE PRE-DDL WINDOW COSTS THE DETECTORS THAT ARE NOT USING THIS FEATURE.
 *
 * The window is real and open-ended — a human runs the file — and three detectors post through it
 * every day, two of which send no `groupKey` at all. Before the capability probe, `group_key: null`
 * was in the INSERT column list unconditionally, so EVERY report from EVERY detector raised 42703,
 * rolled its whole transaction back, logged a warning naming a feature it was not using, and redid
 * the write. Measured here by counting the statements that actually reach the server.
 */
describe('the pre-DDL window costs the untouched detectors nothing', () => {
  const statements = (spy: ReturnType<typeof vi.spyOn>, pattern: RegExp) =>
    spy.mock.calls.filter((call: unknown[]) => typeof call[0] === 'string' && pattern.test(call[0]))
      .length;

  /**
   * 🔴 TRANSACTIONS, NOT INSERTS — and the difference is the whole measurement.
   *
   * A mutant that removes the capability probe still issues exactly ONE findings INSERT, because the
   * statement that raises 42703 on a pre-DDL table is the DELETE that scopes itself by `verdict`,
   * which runs BEFORE any insert. Counting inserts therefore reported 1 for both the fixed and the
   * broken code, i.e. it measured nothing. What the cost actually is — a whole transaction rolled
   * back and redone — is visible as a second `begin`, which is what this counts.
   */
  const transactions = (spy: ReturnType<typeof vi.spyOn>) => statements(spy, /^begin$/i);
  const findingInserts = (spy: ReturnType<typeof vi.spyOn>) =>
    statements(spy, /^insert into "abuse_detection_finding"/i);

  const noKeyReport = {
    detector: 'review-bomb',
    startedAt: '2026-09-07T03:20:00.000Z',
    finishedAt: '2026-09-07T03:20:41.000Z',
    findings: [{ userId: 61, confidence: 0.4, reason: 'no cluster here', actioned: false }],
  };

  beforeEach(async () => {
    await db.exec(`ALTER TABLE abuse_detection_finding
      DROP COLUMN verdict, DROP COLUMN verdict_by, DROP COLUMN verdict_at, DROP COLUMN group_key;`);
  });

  it('writes ONCE and warns not at all for a report carrying no group key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = vi.spyOn(db, 'query' as any);

    await expect(service.recordAbuseRun(noKeyReport)).resolves.toMatchObject({
      runId: expect.any(Number),
    });

    // 🔴 The literals. ONE transaction and ONE findings insert: the second of each is the redo the
    // old 42703 round trip forced on every report from every detector, for a feature two of the
    // three do not use. A positive control on both counters is the sibling case below.
    expect(transactions(query)).toBe(1);
    expect(findingInserts(query)).toBe(1);
    // Nothing was lost, so there is nothing to announce. A warning here every time, forever, is a
    // line whose reader learns to skip it — including on the report where it means something.
    expect(warn).not.toHaveBeenCalled();
    const landed = await db.query<{ user_id: number }>(
      `SELECT user_id FROM abuse_detection_finding ORDER BY id`
    );
    expect(landed.rows.map((r) => r.user_id)).toEqual([61]);
  });

  it('positive control — the same counter reads 1 on a table that HAS the columns', async () => {
    // Without this the `toBe(1)` above is indistinguishable from a counter wired to nothing: a
    // regex that matched neither statement would report 0, and a `toBe(1)` that can never move is
    // not a measurement. Re-applying the columns puts the write on the ordinary path.
    await db.exec(`ALTER TABLE abuse_detection_finding
      ADD COLUMN verdict text, ADD COLUMN verdict_by text,
      ADD COLUMN verdict_at timestamptz, ADD COLUMN group_key text;`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = vi.spyOn(db, 'query' as any);
    await service.recordAbuseRun(noKeyReport);
    expect(transactions(query)).toBe(1);
    expect(findingInserts(query)).toBe(1);
    // And both counters can move, so a `toBe(1)` is a measurement rather than a constant: a second
    // report is a second transaction and a second insert on the same spy.
    await service.recordAbuseRun({ ...noKeyReport, startedAt: '2026-09-07T04:20:00.000Z' });
    expect(transactions(query)).toBe(2);
    expect(findingInserts(query)).toBe(2);
  });

  it('a report that DOES carry a key still says so, once', async () => {
    // The warning is not removed, it is narrowed to the case where something was actually lost.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await service.recordAbuseRun({
      ...noKeyReport,
      findings: [
        { userId: 62, confidence: 0.4, reason: 'in a ring', actioned: false, groupKey: RING },
      ],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('schema.sql'));
  });

  it('🔴 an UNRELATED missing column is not reported as a group_key problem', async () => {
    // Same error code, different fault, opposite remedy. The old branch caught EVERY 42703 and
    // answered "abuse_detection_finding has no group_key column — apply schema.sql", pointing the
    // operator at a file that would not fix this, and logging it just before the real error.
    //
    // 🔴 THE REPORT HERE CARRIES A GROUP KEY, DELIBERATELY. With a keyless report the misleading
    // warning is suppressed by the OTHER guard, so the case passed against a mutant that caught
    // every 42703 — green for the wrong reason, and measured: that mutant survived until this
    // fixture carried a key.
    await db.exec(`ALTER TABLE abuse_detection_finding
      ADD COLUMN verdict text, ADD COLUMN verdict_by text,
      ADD COLUMN verdict_at timestamptz, ADD COLUMN group_key text;`);
    await db.exec(`ALTER TABLE abuse_detection_finding DROP COLUMN action;`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = vi.spyOn(db, 'query' as any);

    await expect(
      service.recordAbuseRun({
        ...noKeyReport,
        findings: [
          { userId: 64, confidence: 0.4, reason: 'in a ring', actioned: false, groupKey: RING },
        ],
      })
    ).rejects.toMatchObject({
      code: '42703',
      // The REAL fault, unrewritten and unburied.
      message: expect.stringContaining('"action"'),
    });
    // Not diagnosed as this feature's problem. 🔴 This line is NOT what kills the "catch every
    // 42703" mutant — measured: under that mutant the warning is emitted only AFTER the retry
    // succeeds, and the retry cannot succeed while `action` is still missing, so nothing is logged
    // either way. It is a guard against the message MOVING back before the write, not the one
    // holding this property.
    expect(warn).not.toHaveBeenCalled();
    // 🔴 THIS is the killing assertion, and it reads `expected 2 to be 1` under that mutant. A retry
    // cannot help here — the column is still missing — so catching every 42703 buys a second
    // rolled-back transaction and arrives at the identical error.
    expect(transactions(query)).toBe(1);
  });

  it('a HALF-applied DDL is treated as not applied', async () => {
    // Three of the four columns present is not "applied". The degraded shape is the one that cannot
    // be wrong about a column it never names, so it is what a partial application gets.
    await db.exec(`ALTER TABLE abuse_detection_finding
      ADD COLUMN verdict text, ADD COLUMN verdict_by text, ADD COLUMN verdict_at timestamptz;`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = vi.spyOn(db, 'query' as any);

    await service.recordAbuseRun({
      ...noKeyReport,
      findings: [
        { userId: 63, confidence: 0.4, reason: 'in a ring', actioned: false, groupKey: RING },
      ],
    });

    expect(transactions(query)).toBe(1);
    expect(findingInserts(query)).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('schema.sql'));
    // Read without naming `group_key` — the whole premise of this case is that the column is absent,
    // and the shared `allFindings` helper selects it.
    const landed = await db.query<{ user_id: number }>(
      `SELECT user_id FROM abuse_detection_finding ORDER BY id`
    );
    expect(landed.rows.map((r) => r.user_id)).toEqual([63]);
  });
});

/**
 * 🔴 THE OTHER "the DDL was applied by the wrong role" STATE, on the WRITE path.
 *
 * Both of this board's read paths already discriminate `42501` and say "re-run schema.sql as the
 * application role". The write did not: it translated `42703` and let everything else fall through
 * to the route's generic "the verdict was NOT recorded — the database refused the write", which
 * reads as an outage on a database that is serving every row it holds. The file's own header exists
 * because `psql -U postgres` is the natural shortcut, so this is a likely state, not a hypothetical.
 */
describe('a ruling refused for want of privilege', () => {
  it('names the file and the role, not a generic refusal', async () => {
    const runId = await seedRun(db, 'bot-account-detection', STARTED_TODAY);
    const findingId = await seedFinding(db, { runId, userId: 21 });

    await db.exec(`CREATE ROLE internal_tools LOGIN;`);
    // SELECT but not UPDATE: the target lookup must SUCCEED, so the refusal is attributable to the
    // UPDATE rather than to a role that cannot see the table at all — which would fail this test
    // for a completely different reason and read as coverage.
    await db.exec(`GRANT SELECT ON abuse_detection_finding TO internal_tools;`);
    await db.exec(`SET ROLE internal_tools;`);
    try {
      await expect(
        service.recordAbuseVerdict({ runId, findingId, verdict: 'tp', verdictBy: '77' })
      ).rejects.toThrow(/schema\.sql/);
      // And the cause is preserved, so the real code is still readable in a log.
      await service
        .recordAbuseVerdict({ runId, findingId, verdict: 'tp', verdictBy: '77' })
        .catch((e: Error & { cause?: { code?: string } }) => {
          expect(e.cause?.code).toBe('42501');
          expect(e.message).toMatch(/application role/);
        });
    } finally {
      await db.exec(`RESET ROLE;`);
    }
  });

  it('positive control — the same ruling succeeds once the role may write', async () => {
    // Without this, the rejection above is indistinguishable from a fixture that could never have
    // recorded a verdict at all.
    const runId = await seedRun(db, 'bot-account-detection', STARTED_TODAY);
    const findingId = await seedFinding(db, { runId, userId: 21 });
    await db.exec(`CREATE ROLE internal_tools LOGIN;`);
    await db.exec(`GRANT SELECT, UPDATE ON abuse_detection_finding TO internal_tools;`);
    await db.exec(`SET ROLE internal_tools;`);
    try {
      await expect(
        service.recordAbuseVerdict({ runId, findingId, verdict: 'tp', verdictBy: '77' })
      ).resolves.toEqual({ updated: 1, groupKey: null });
    } finally {
      await db.exec(`RESET ROLE;`);
    }
  });
});

describe('missingColumnFromError', () => {
  // The two spellings a real server produces, captured from PGlite 0.4.6 rather than invented:
  // `checkInsertTargets` names the relation, `errorMissingColumn` does not, and NEITHER populates an
  // `error.column` field — which is why this reads the message at all.
  it.each([
    ['an INSERT target', 'column "group_key" of relation "abuse_detection_finding" does not exist'],
    ['a WHERE clause', 'column "verdict" does not exist'],
  ])('reads the column name out of %s', (_label, message) => {
    expect(
      service.missingColumnFromError(Object.assign(new Error(message), { code: '42703' }))
    ).toBe(message.includes('group_key') ? 'group_key' : 'verdict');
  });

  it('answers null for any other error code, however similar the message', () => {
    // The code is the discriminator, not the prose: a message mentioning a column on a connection
    // failure must not be read as a schema problem.
    const e = Object.assign(new Error('column "verdict" does not exist'), { code: '57P01' });
    expect(service.missingColumnFromError(e)).toBeNull();
  });

  it('answers null for a 42703 whose message it does not recognise', () => {
    // The safe direction: an unparsed failure propagates rather than being retried past.
    expect(
      service.missingColumnFromError(Object.assign(new Error('no idea'), { code: '42703' }))
    ).toBeNull();
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
