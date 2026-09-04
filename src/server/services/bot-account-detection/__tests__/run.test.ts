import {
  MAX_FINDINGS_PER_REPORT,
  abuseReportInput,
  type AbuseReportInput,
} from '@civitai/moderation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, mockNode } from '~/__tests__/mocks';
import type { CohortReader, NewAccountRow } from '../cohort';
import { BOT_ACCOUNT_DETECTOR } from '../report';
import { BOT_ACCOUNT_HEURISTICS, type BotAccountHeuristic } from '../scoring';
import { BotAccountReportError, runBotAccountDetection } from '../run';

const STARTED = new Date('2026-09-03T03:20:00.000Z');
const FINISHED = new Date('2026-09-03T03:20:12.000Z');

const account = (id: number): NewAccountRow => ({
  id,
  username: `u${id}`,
  createdAt: new Date('2026-09-03T01:00:00.000Z'),
});

/**
 * A reader over a fixed account list that RECORDS every operation it is asked for.
 *
 * The recording is the point. This port is the run's ENTIRE database surface, so the recorded set
 * is a ledger of what the run did to the database — and a ledger fails when the set grows, which a
 * check for a named forbidden call cannot.
 */
function recordingReader(accounts: NewAccountRow[], postedIds?: Set<number>) {
  const operations: string[] = [];
  const reader: CohortReader = {
    // Descending keyset, matching the real reader: ids strictly BELOW `before`, newest first.
    listNewAccounts: async ({ before, take }) => {
      operations.push('listNewAccounts');
      return [...accounts]
        .sort((a, b) => b.id - a.id)
        .filter((a) => before === undefined || a.id < before)
        .slice(0, take);
    },
    countPosts: async (ids) => {
      operations.push('countPosts');
      return {
        comments: [],
        commentsV2: [],
        models: [],
        images: ids
          .filter((id) => !postedIds || postedIds.has(id))
          .map((userId) => ({ userId, count: 1 })),
      };
    },
  };
  return { reader, operations };
}

function sink() {
  const reports: AbuseReportInput[] = [];
  return {
    reports,
    sendReport: vi.fn(async (report: AbuseReportInput) => {
      reports.push(report);
      return { runId: reports.length };
    }),
  };
}

/** A clock that returns STARTED first and FINISHED after — two distinct instants, so a report that
 *  stamps one field from the other is visible. */
function clock() {
  let call = 0;
  return () => (call++ === 0 ? STARTED : FINISHED);
}

const constantHeuristic = (id: string, value: number): BotAccountHeuristic => ({
  id,
  description: `test ${id}`,
  weight: 1,
  score: () => value,
  explain: () => null,
});

const run = (
  accounts: NewAccountRow[],
  overrides: Parameters<typeof runBotAccountDetection>[1] = {},
  postedIds?: Set<number>
) => {
  const { reader, operations } = recordingReader(accounts, postedIds);
  const out = sink();
  return {
    operations,
    ...out,
    result: runBotAccountDetection(
      {
        reader,
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [constantHeuristic('h', 0.4)],
      },
      { pageSize: 100, maxAccounts: 1_000, ...overrides }
    ),
  };
};

describe('runBotAccountDetection', () => {
  it('files the cohort as one report when it fits', async () => {
    const scenario = run([account(1), account(2)]);
    const result = await scenario.result;
    expect(result).toMatchObject({
      detector: BOT_ACCOUNT_DETECTOR,
      scanned: 2,
      cohortSize: 2,
      capped: false,
      reports: 1,
      reportsSent: 1,
    });
    expect(scenario.reports[0].findings.map((f) => f.userId)).toEqual([2, 1]);
  });

  it('marks every finding of every batch un-actioned', async () => {
    const scenario = run(
      Array.from({ length: 7 }, (_, i) => account(i + 1)),
      {
        maxFindingsPerReport: 3,
      }
    );
    await scenario.result;
    const findings = scenario.reports.flatMap((r) => r.findings);
    expect(findings).toHaveLength(7);
    expect(findings.every((f) => f.actioned === false)).toBe(true);
    expect(findings.some((f) => 'action' in f)).toBe(false);
  });

  it('uses the producer’s own clock for both timestamps', async () => {
    const scenario = run([account(1)]);
    await scenario.result;
    // startedAt is the FIRST read and finishedAt the SECOND — a report that stamps both from one
    // read, or that lets the receiver default them, is what makes the board's "how current is this"
    // reading quietly wrong.
    expect(scenario.reports[0].startedAt).toBe(STARTED.toISOString());
    expect(scenario.reports[0].finishedAt).toBe(FINISHED.toISOString());
  });

  it('sends payloads the real wire contract accepts', async () => {
    const scenario = run([account(1), account(2)]);
    await scenario.result;
    for (const report of scenario.reports)
      expect(() => abuseReportInput.parse(report)).not.toThrow();
  });

  it('excludes accounts that have not posted, and still counts them as scanned', async () => {
    const scenario = run(
      [account(1), account(2), account(3)],
      {},
      new Set([2]) // only #2 posted
    );
    const result = await scenario.result;
    expect(result.cohortSize).toBe(1);
    expect(result.scanned).toBe(3);
    expect(scenario.reports[0].findings.map((f) => f.userId)).toEqual([2]);
  });

  it('batches across reports at the real cap, with distinct startedAt per batch', async () => {
    // 2,501 overshoots the 1,000 cap by a non-multiple, so the remainder batch runs.
    const scenario = run(
      Array.from({ length: 2_501 }, (_, i) => account(i + 1)),
      {
        pageSize: 1_000,
        maxAccounts: 5_000,
      }
    );
    const result = await scenario.result;
    expect(MAX_FINDINGS_PER_REPORT).toBe(1_000);
    expect(result.reports).toBe(3);
    expect(result.reportsSent).toBe(3);
    expect(scenario.reports.map((r) => r.findings.length)).toEqual([1_000, 1_000, 501]);
    // 🔴 Sharing a startedAt would make the receiving upsert REPLACE the previous batch instead of
    // adding to it — the run would land as its last 501 findings with nothing to say so.
    expect(new Set(scenario.reports.map((r) => r.startedAt)).size).toBe(3);
  });

  it('reports the cap in the counters and the summary when it truncates', async () => {
    // 13 against a cap of 8 at page size 4: overshoots the cap, and the cap is neither a multiple
    // nor a power-of-two multiple of the page size, so the budget-clamped page runs.
    const scenario = run(
      Array.from({ length: 13 }, (_, i) => account(i + 1)),
      {
        pageSize: 4,
        maxAccounts: 8,
      }
    );
    const result = await scenario.result;
    expect(result.capped).toBe(true);
    expect(result.scanned).toBe(8);
    expect(scenario.reports[0].counters?.cohort_capped).toBe(1);
    expect(scenario.reports[0].counters?.cohort_cap).toBe(8);
    expect(scenario.reports[0].summary).toContain('TRUNCATED');
    // 🔴 The findings that survived a cap are the NEWEST accounts, end to end through the run —
    // not only inside `collectCohort`.
    expect(scenario.reports[0].findings.map((f) => f.userId)).toEqual([13, 12, 11, 10, 9, 8, 7, 6]);
  });

  it('says WHICH END the cap dropped, in the summary a moderator reads', async () => {
    // "TRUNCATED at the N-account cap" alone is read as "we saw the first N", and in a signup
    // window "first" means oldest — the exact opposite of what the walk does. A moderator who
    // reads it that way concludes the newest signups went unexamined and goes looking for them.
    const scenario = run(
      Array.from({ length: 13 }, (_, i) => account(i + 1)),
      { pageSize: 4, maxAccounts: 8 }
    );
    await scenario.result;
    const summary = scenario.reports[0].summary ?? '';
    expect(summary).toContain('NEWEST FIRST');
    expect(summary).toContain('OLDEST end');
    // The whole normalised sentence, so a cosmetic reword has to be a deliberate edit rather than
    // something that slips past a keyword check while inverting the meaning.
    expect(summary).toContain(
      '🔴 TRUNCATED at the 8-account cap. Accounts are read NEWEST FIRST, so the 8 read are the ' +
        'most recent of the window and the unread remainder is its OLDEST end — the earliest ' +
        'signups of the window were not scored.'
    );
  });

  it('publishes cohort_capped as a zero on an untruncated run', async () => {
    const scenario = run([account(1)]);
    await scenario.result;
    // Not omitted. A counter that only appears in the bad case cannot be alerted on, because its
    // absence is indistinguishable from the producer not running.
    expect(scenario.reports[0].counters?.cohort_capped).toBe(0);
    expect(scenario.reports[0].summary).not.toContain('TRUNCATED');
  });

  it('publishes a per-heuristic count for every registered heuristic', async () => {
    const { reader } = recordingReader([account(1), account(2)]);
    const out = sink();
    await runBotAccountDetection(
      {
        reader,
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [constantHeuristic('loud', 0.9), constantHeuristic('quiet', 0)],
      },
      { pageSize: 10, maxAccounts: 10 }
    );
    expect(out.reports[0].counters).toMatchObject({
      heuristics_registered: 2,
      'heuristic:loud:evaluated': 2,
      'heuristic:loud:fired': 2,
      'heuristic:quiet:evaluated': 2,
      'heuristic:quiet:fired': 0,
    });
  });

  it('still files a report for an empty window', async () => {
    const scenario = run([]);
    const result = await scenario.result;
    expect(result.cohortSize).toBe(0);
    expect(result.reportsSent).toBe(1);
    expect(scenario.reports[0].findings).toEqual([]);
  });

  it('surfaces a failed batch with how much of the run already landed', async () => {
    const { reader } = recordingReader(Array.from({ length: 5 }, (_, i) => account(i + 1)));
    const sendReport = vi
      .fn<(_report: AbuseReportInput) => Promise<unknown>>()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('502 from the spoke'));
    await expect(
      runBotAccountDetection(
        { reader, sendReport, now: clock(), heuristics: [] },
        { pageSize: 10, maxAccounts: 10, maxFindingsPerReport: 2 }
      )
      // A bare rethrow would say "the run failed" and hide that a third of it is already on the
      // board — which is what a reader has to know before retrying, since a retry re-sends under a
      // NEW startedAt and duplicates rather than upserting.
    ).rejects.toThrow(BotAccountReportError);
    expect(sendReport).toHaveBeenCalledTimes(2);
  });

  it('stops at the next report when the job is canceled', async () => {
    // Past `lockExpiration` the run-jobs route RELEASES the lock while the run continues, so an
    // overrunning run is how a retry starts a second one whose different `startedAt` the board
    // cannot merge. Cancellation is checked before each send, not only per page, because sending
    // is where a canceled run does damage the board can see.
    const { reader } = recordingReader(Array.from({ length: 5 }, (_, i) => account(i + 1)));
    const out = sink();
    let checks = 0;
    await expect(
      runBotAccountDetection(
        {
          reader,
          sendReport: out.sendReport,
          now: clock(),
          heuristics: [],
          checkCanceled: () => {
            checks += 1;
            // Pages first, then one send, then canceled.
            if (checks > 2) throw new Error('Job was canceled');
          },
        },
        { pageSize: 10, maxAccounts: 10, maxFindingsPerReport: 2 }
      )
    ).rejects.toThrow('Job was canceled');
    expect(out.sendReport).toHaveBeenCalledTimes(1);
  });

  it('logs each batch as it lands', async () => {
    const { reader } = recordingReader(Array.from({ length: 5 }, (_, i) => account(i + 1)));
    const out = sink();
    const log = vi.fn();
    await runBotAccountDetection(
      { reader, sendReport: out.sendReport, now: clock(), heuristics: [], log },
      { pageSize: 10, maxAccounts: 10, maxFindingsPerReport: 2 }
    );
    const sent = log.mock.calls.filter(([name]) => name === 'bot-account-detection:report-sent');
    expect(sent.map(([, data]) => data.batch)).toEqual([1, 2, 3]);
    expect(sent.every(([, data]) => data.of === 3)).toBe(true);
  });
});

describe('the shadow-mode invariant: nothing is muted, banned or restricted', () => {
  beforeEach(() => {
    // The canonical `~/server/db/client` mock is reset per file by the global setup; these paths
    // are named so the assertions below read against a spy that definitely exists.
    void dbMock.dbWrite;
  });

  it('performs exactly two kinds of database operation, both reads', async () => {
    const scenario = run(
      Array.from({ length: 5 }, (_, i) => account(i + 1)),
      { pageSize: 2 }
    );
    await scenario.result;
    // 🔴 AN ASSERTED LEDGER, not a check for a forbidden name. It fails if the set GROWS — which is
    // what adding a write looks like — and if it SHRINKS. The reader port is the run's entire
    // database surface, so this is the whole of what the run did to the database.
    expect([...new Set(scenario.operations)].sort()).toEqual(['countPosts', 'listNewAccounts']);
  });

  it('never touches the write client', async () => {
    const scenario = run(Array.from({ length: 3 }, (_, i) => account(i + 1)));
    await scenario.result;
    // The behavioural half of the guard, against the REAL global `dbWrite` spy rather than a local
    // fake: it sees a write issued from anywhere in the run's import graph, including one this
    // module's own fakes know nothing about. The structural half — which sees a write that this
    // fixture's data happens not to reach — is `no-write-surface.test.ts`.
    for (const path of [
      'dbWrite.user.update',
      'dbWrite.user.updateMany',
      'dbWrite.userRestriction.create',
      'dbWrite.userRestriction.update',
      'dbWrite.$transaction',
      'dbWrite.$executeRaw',
      'dbWrite.$executeRawUnsafe',
      'dbWrite.$queryRaw',
    ])
      expect(mockNode(path), `${path} was called by a shadow-mode run`).not.toHaveBeenCalled();
  });

  it('holds with the PRODUCTION heuristic registry, not only injected fakes', async () => {
    // 🔴 Every other case here injects `heuristics`, so `BOT_ACCOUNT_HEURISTICS` — the registry a
    // real run actually uses, and the one the first real heuristic will be added to — was never
    // exercised against the real `dbWrite` spy. A heuristic that reached for a write client would
    // have been invisible to this whole file.
    const { reader, operations } = recordingReader(
      Array.from({ length: 3 }, (_, i) => account(i + 1))
    );
    const out = sink();
    const result = await runBotAccountDetection(
      { reader, sendReport: out.sendReport, now: clock() }, // no `heuristics` override
      { pageSize: 10, maxAccounts: 10 }
    );

    expect(result.counters.heuristics_registered).toBe(BOT_ACCOUNT_HEURISTICS.length);
    expect(BOT_ACCOUNT_HEURISTICS.length).toBeGreaterThan(0);
    // Every registered heuristic reports its own counters, so a registry member that silently
    // fails to run is visible rather than absorbed into the blend.
    for (const heuristic of BOT_ACCOUNT_HEURISTICS)
      expect(out.reports[0].counters?.[`heuristic:${heuristic.id}:evaluated`]).toBe(3);

    expect([...new Set(operations)].sort()).toEqual(['countPosts', 'listNewAccounts']);
    for (const path of [
      'dbWrite.user.update',
      'dbWrite.userRestriction.create',
      'dbWrite.$transaction',
      'dbWrite.$executeRawUnsafe',
    ])
      expect(mockNode(path), `${path} was called by a real-registry run`).not.toHaveBeenCalled();
    expect(JSON.stringify(out.reports)).not.toContain('"actioned":true');
  });

  it('sends nothing that claims an action was taken', async () => {
    const scenario = run(
      Array.from({ length: 7 }, (_, i) => account(i + 1)),
      {
        maxFindingsPerReport: 3,
      }
    );
    await scenario.result;
    const payload = JSON.stringify(scenario.reports);
    expect(payload).not.toContain('"actioned":true');
    expect(payload).not.toContain('"action"');
  });
});
