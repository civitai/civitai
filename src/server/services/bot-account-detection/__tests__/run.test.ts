import {
  MAX_FINDINGS_PER_REPORT,
  abuseReportInput,
  type AbuseReportInput,
} from '@civitai/moderation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, mockNode } from '~/__tests__/mocks';
import type { CohortReader, NewAccountRow } from '../cohort';
import { BOT_ACCOUNT_DETECTOR } from '../report';
import { BOT_ACCOUNT_HEURISTICS } from '../heuristics';
import { MIN_REPORTED_CONFIDENCE, type BotAccountHeuristic } from '../scoring';
import { BotAccountReportError, runBotAccountDetection } from '../run';

const STARTED = new Date('2026-09-03T03:20:00.000Z');
const FINISHED = new Date('2026-09-03T03:20:12.000Z');

const account = (id: number): NewAccountRow => ({
  id,
  username: `u${id}`,
  createdAt: new Date('2026-09-03T01:00:00.000Z'),
  // A distinct domain per account: a shared one would make every fixture a domain cluster and
  // silently change what the clustering heuristic scores in tests that are about something else.
  email: `u${id}@u${id}.test`,
});

/**
 * A reader over a fixed account list that RECORDS every operation it is asked for.
 *
 * The recording is the point. This port is the run's ENTIRE database surface, so the recorded set
 * is a ledger of what the run did to the database — and a ledger fails when the set grows, which a
 * check for a named forbidden call cannot.
 */
function recordingReader(
  accounts: NewAccountRow[],
  postedIds?: Set<number>,
  /** Ids whose content is all gone — posted, but nothing left on the site. The bot-wave shape. */
  blockedIds?: Set<number>
) {
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
      const posted = ids.filter((id) => !postedIds || postedIds.has(id));
      return {
        comments: [],
        commentsV2: [],
        models: [],
        // Still on the site: everything the account posted, unless it is one of the blocked ones.
        images: posted.filter((id) => !blockedIds?.has(id)).map((userId) => ({ userId, count: 1 })),
        allComments: [],
        allCommentsV2: [],
        allModels: [],
        allImages: posted.map((userId) => ({ userId, count: blockedIds?.has(userId) ? 40 : 1 })),
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
  postedIds?: Set<number>,
  blockedIds?: Set<number>
) => {
  const { reader, operations } = recordingReader(accounts, postedIds, blockedIds);
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

/** A run whose heuristics score each account a value chosen by id, so a case can build an exact
 *  confidence distribution and then assert what the threshold did to it. */
const runScoring = (
  byId: Record<number, number>,
  overrides: Parameters<typeof runBotAccountDetection>[1] = {}
) => {
  const accounts = Object.keys(byId).map((id) => account(Number(id)));
  const { reader } = recordingReader(accounts);
  const out = sink();
  return {
    ...out,
    result: runBotAccountDetection(
      {
        reader,
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [
          {
            id: 'tunable',
            description: 'test',
            weight: 1,
            score: ({ member }) => byId[member.userId] ?? 0,
            explain: () => null,
          },
        ],
      },
      { pageSize: 100, maxAccounts: 1_000, ...overrides }
    ),
  };
};

describe('the reporting threshold, end to end', () => {
  it('🔴 reports only the members above the cut, and COUNTS the rest', async () => {
    // 🔴 THE FAILURE THIS EXISTS TO PREVENT. `run.ts` turned every cohort member into a finding
    // with no confidence filter anywhere. With three real heuristics that puts a whole day's
    // posting cohort on a live moderator board as confidence-0 rows — a board that is mostly noise
    // on its first day is a board nobody reads on its second.
    //
    // Five members, one above the default 0.15 cut. Values overshoot the boundary in both
    // directions rather than sitting on it.
    const scenario = runScoring({ 1: 0.02, 2: 0.9, 3: 0, 4: 0.04, 5: 0.31 });
    const result = await scenario.result;

    expect(result.cohortSize).toBe(5);
    expect(result.findingsReported).toBe(2);
    expect(result.findingsSuppressed).toBe(3);
    expect(result.minConfidence).toBe(MIN_REPORTED_CONFIDENCE);
    expect(scenario.reports[0].findings.map((f) => f.userId).sort()).toEqual([2, 5]);
  });

  it('🔴 the suppressed members are still in the distribution counters', async () => {
    // The counterweight that makes the threshold safe. A member nobody can see is a member nobody
    // can grade, and grading is the entire purpose of the shadow phase. "2 findings" over a cohort
    // of 5 is only readable next to the three that scored under the cut.
    const scenario = runScoring({ 1: 0.02, 2: 0.9, 3: 0, 4: 0.04, 5: 0.31 });
    await scenario.result;
    const counters = scenario.reports[0].counters ?? {};

    expect(counters.findings_reported).toBe(2);
    expect(counters.findings_suppressed).toBe(3);
    expect(counters.report_min_confidence).toBe(MIN_REPORTED_CONFIDENCE);
    // Three members under 0.1, one in 0.3-0.4, one in 0.9-1.0.
    expect(counters['confidence_bucket_0_10']).toBe(3);
    expect(counters['confidence_bucket_30_40']).toBe(1);
    expect(counters['confidence_bucket_90_100']).toBe(1);
    // 🔴 The buckets sum back to the COHORT, not to the findings. That equality is the whole claim:
    // nothing was dropped between scoring and reporting without being counted.
    const bucketTotal = Object.entries(counters)
      .filter(([k]) => k.startsWith('confidence_bucket_'))
      .reduce((sum, [, v]) => sum + (v as number), 0);
    expect(bucketTotal).toBe(counters.cohort_size);
    expect(bucketTotal).toBe(counters.findings_reported + counters.findings_suppressed);
  });

  it('publishes every bucket on a run where nothing scored, zeros included', async () => {
    // A counter that appears only in the interesting case cannot be alerted on.
    const scenario = runScoring({ 1: 0, 2: 0 });
    await scenario.result;
    const counters = scenario.reports[0].counters ?? {};
    const buckets = Object.keys(counters).filter((k) => k.startsWith('confidence_bucket_'));
    expect(buckets).toHaveLength(10);
    expect(counters['confidence_bucket_90_100']).toBe(0);
  });

  it('says what it suppressed in the summary a human reads first', async () => {
    const scenario = runScoring({ 1: 0.02, 2: 0.9, 3: 0 });
    await scenario.result;
    const summary = scenario.reports[0].summary ?? '';
    expect(summary).toContain('1 scored at or above the 0.15 reporting threshold');
    expect(summary).toContain('2 scored under it');
    expect(summary).toContain('NOT reported as findings');
  });

  it('a threshold of 0 restores the full-cohort run', async () => {
    const scenario = runScoring({ 1: 0, 2: 0, 3: 0 }, { minConfidence: 0 });
    const result = await scenario.result;
    expect(result.findingsReported).toBe(3);
    expect(result.findingsSuppressed).toBe(0);
  });

  it('still files an empty report when everything was suppressed', async () => {
    // "No report today" and "a report with zero findings" look the same to a reader otherwise, and
    // the first is what a broken producer looks like.
    const scenario = runScoring({ 1: 0, 2: 0 });
    const result = await scenario.result;
    expect(result.reportsSent).toBe(1);
    expect(scenario.reports[0].findings).toEqual([]);
    expect(scenario.reports[0].counters?.findings_suppressed).toBe(2);
  });
});

/**
 * The reason string's `Per-heuristic: a=0.60, b=0.00` clause, parsed back into a map.
 *
 * Read off the EMITTED FINDING rather than off an intermediate, because the finding is the only
 * thing that leaves this process — an assertion on a score object one layer up cannot tell whether
 * that score ever reached the board.
 */
function subScoresOf(finding: { reason: string }): Record<string, number> {
  // Anchored on the clause that FOLLOWS it, because the scores themselves contain full stops —
  // `[^.]*` reads `posting-velocity=0` and stops, which is a parse that looks like a value.
  const clause = /Per-heuristic: (.*?)\. Blended confidence/.exec(finding.reason);
  if (!clause) throw new Error(`no per-heuristic clause in reason: ${finding.reason}`);
  return Object.fromEntries(
    clause[1].split(', ').map((pair) => {
      const [id, value] = pair.split('=');
      return [id, Number(value)];
    })
  );
}

describe('🔴 the seam between the evidence and the scoring', () => {
  /**
   * A cohort of six accounts that share ONE registration IP and ONE templated comment, run end to
   * end through the PRODUCTION heuristic registry with a real `EvidenceReader` behind it.
   *
   * Six, not three: at the shipped boundaries six members on one address is where the IP ramp
   * reaches 0.5, and it overshoots `IP_ZERO_AT`/`CLUSTER_ZERO_AT` rather than sitting on them.
   */
  const RING_TEXT = 'Grab your 100 free credits here: https://spam.example/ref1';
  const ringRun = (evidence: Parameters<typeof runBotAccountDetection>[0]['evidence']) => {
    const accounts = Array.from({ length: 6 }, (_, i) => account(i + 1));
    const { reader } = recordingReader(accounts);
    const out = sink();
    return {
      ...out,
      result: runBotAccountDetection(
        { reader, evidence, sendReport: out.sendReport, now: clock() }, // production registry
        { pageSize: 10, maxAccounts: 10, minConfidence: 0 }
      ),
    };
  };

  const ringEvidence = {
    hasRegistrationIps: true,
    listRegistrationIps: async (ids: number[]) =>
      ids.map((userId) => ({ userId, ip: '203.0.113.9' })),
    listContentSamples: async (ids: number[]) =>
      ids.map((userId) => ({ userId, content: RING_TEXT })),
  };

  it('🔴 the cohort-level evidence REACHES the scoring, and the finding proves it', async () => {
    // 🔴 THE MUTANT THIS EXISTS FOR, AND IT IS THE MOST EXPENSIVE ONE IN THIS TREE. Replacing the
    // `signals` handed to `scoreAccount` with `emptyCohortSignals()` left the entire suite green:
    // `evidence.test.ts` covers the index, `heuristics.test.ts` covers the pure scorers over
    // hand-built signals, `run.test.ts` covered the threshold — and NO test ever built the combined
    // state. Two of the three heuristics would have scored 0 for every account on every production
    // run while `evidence_registration_ips`, `evidence_distinct_registration_ips` and
    // `evidence_distinct_content_fingerprints` all reported healthy values, because those read
    // `signals` rather than what scoring saw. Two-thirds of the detector inert, every counter
    // saying it was fine.
    //
    // The assertion is on the EMITTED FINDING's own sub-scores. A score object, or a counter, is a
    // claim about an intermediate; the finding is what reaches the board.
    const scenario = ringRun(ringEvidence);
    await scenario.result;

    const finding = scenario.reports[0].findings.find((f) => f.userId === 1);
    expect(finding).toBeDefined();
    const sub = subScoresOf(finding as { reason: string });

    // A positive control on the parse before either number is believed: all three registered
    // heuristics are present, so a regex that matched a fragment cannot read as a pass.
    expect(Object.keys(sub).sort()).toEqual([
      'content-templating',
      'posting-velocity',
      'registration-cluster',
    ]);

    // 🔴 THE TWO THAT GO INERT. Both read `signals` and nothing else; under the mutant both are 0.
    expect(sub['registration-cluster']).toBeGreaterThan(0);
    expect(sub['content-templating']).toBeGreaterThan(0);
    // Six on one address and six on one fingerprint, at the shipped boundaries.
    expect(sub['registration-cluster']).toBeCloseTo(0.5, 6);
    expect(sub['content-templating']).toBeCloseTo(0.5, 6);
    // And the blend a moderator sorts on moved with them, rather than the sub-scores being
    // decoration on a number computed elsewhere.
    expect(finding?.confidence).toBeCloseTo(1 / 3, 6);

    // The reason a moderator reads names WHAT was seen, not only that something was.
    expect(finding?.reason).toContain('6 new posting accounts share its registration IP');
    expect(finding?.reason).toContain('6 new accounts posted the same text');
  });

  it('the same cohort with NO evidence reader scores both ring heuristics 0 — the control', async () => {
    // The other arm. Without it the case above cannot attribute anything: a finding whose ring
    // sub-scores are non-zero proves the seam only if they are zero when the evidence is absent,
    // and that is exactly the state the mutant manufactures.
    const scenario = ringRun(undefined);
    await scenario.result;
    const sub = subScoresOf(
      scenario.reports[0].findings.find((f) => f.userId === 1) as { reason: string }
    );
    expect(sub['registration-cluster']).toBe(0);
    expect(sub['content-templating']).toBe(0);
  });
});

describe('the evidence sources are reported, not assumed', () => {
  it('🔴 a run with NO evidence reader says the ring sources did not run', async () => {
    // Two of the three heuristics score 0 when their source is missing, which is byte-identical to
    // scoring 0 because nothing was found. These counters are the only things that tell the two
    // apart — without them a grading pass averages blind runs in as evidence of no rings.
    const scenario = run([account(1)]);
    await scenario.result;
    const counters = scenario.reports[0].counters ?? {};
    expect(counters.evidence_registration_ips).toBe(0);
    expect(counters.evidence_content_budget_exhausted).toBe(0);
    expect(counters.evidence_members_sampled_for_content).toBe(0);
  });

  it('reports the sources as present when the reader answered', async () => {
    const { reader } = recordingReader([account(1), account(2)]);
    const out = sink();
    await runBotAccountDetection(
      {
        reader,
        evidence: {
          hasRegistrationIps: true,
          listRegistrationIps: async () => [
            { userId: 1, ip: 'x' },
            { userId: 2, ip: 'x' },
          ],
          listContentSamples: async () => [],
        },
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [],
      },
      { pageSize: 100, maxAccounts: 100, minConfidence: 0 }
    );
    const counters = out.reports[0].counters ?? {};
    expect(counters.evidence_registration_ips).toBe(1);
    expect(counters.evidence_distinct_registration_ips).toBe(1);
    expect(counters.evidence_members_sampled_for_content).toBe(2);
  });

  it('warns in the summary when the IP source was unavailable', async () => {
    const scenario = run([account(1)]);
    await scenario.result;
    expect(scenario.reports[0].summary).toContain('REGISTRATION-IP DATA WAS UNAVAILABLE');
  });

  it('🔴 says so when the IP read RAN and matched nothing — the wrong-query signature', async () => {
    // 🔴 THE CASE THE AVAILABILITY FLAG CANNOT EXPRESS. `evidence_registration_ips: 1` with
    // `evidence_distinct_registration_ips: 0` over a non-empty cohort is what a changed column, a
    // moved table or an over-tight filter looks like — and it is also what a quiet day looks like.
    // The counters carried both numbers; the summary, which is what a human reads first, said
    // nothing at all, so the two states were indistinguishable to the only reader who would
    // recognise the difference.
    const { reader } = recordingReader([account(1), account(2)]);
    const out = sink();
    await runBotAccountDetection(
      {
        reader,
        evidence: {
          hasRegistrationIps: true,
          listRegistrationIps: async () => [],
          listContentSamples: async () => [],
        },
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [],
      },
      { pageSize: 10, maxAccounts: 10, minConfidence: 0 }
    );
    const summary = out.reports[0].summary ?? '';
    expect(summary).toContain('THE REGISTRATION-IP READ RAN AND MATCHED NOTHING for any of the 2');
    expect(summary).toContain('wrong column, a moved table or an over-tight filter');
    // And it does NOT also claim the source was unavailable — the two clauses are mutually
    // exclusive, and emitting both would make each meaningless.
    expect(summary).not.toContain('REGISTRATION-IP DATA WAS UNAVAILABLE');
    expect(out.reports[0].counters?.evidence_registration_ips).toBe(1);
    expect(out.reports[0].counters?.evidence_distinct_registration_ips).toBe(0);
  });

  it('stays quiet when the IP read ran and DID match — the negative control', async () => {
    // The clause above must not fire on an ordinary run, or it is noise that trains a reader to
    // skip the summary.
    const { reader } = recordingReader([account(1), account(2)]);
    const out = sink();
    await runBotAccountDetection(
      {
        reader,
        evidence: {
          hasRegistrationIps: true,
          listRegistrationIps: async () => [{ userId: 1, ip: '203.0.113.4' }],
          listContentSamples: async () => [],
        },
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [],
      },
      { pageSize: 10, maxAccounts: 10, minConfidence: 0 }
    );
    expect(out.reports[0].summary).not.toContain('MATCHED NOTHING');
  });

  it('🔴 a failing CONTENT read degrades the run: a report is still filed, and it SAYS so', async () => {
    // 🔴 THE FAILURE THIS EXISTS TO PREVENT, END TO END. `listContentSamples` had no guard, so a
    // replica timeout propagated out of the run and NO REPORT WAS FILED AT ALL — the velocity
    // heuristic's day lost with it, and the whole thing indistinguishable from a producer that
    // stopped running. Under the pre-fix code this case does not fail an assertion, it REJECTS.
    const { reader } = recordingReader([account(1), account(2)]);
    const out = sink();
    const result = await runBotAccountDetection(
      {
        reader,
        evidence: {
          hasRegistrationIps: false,
          listRegistrationIps: async () => [],
          listContentSamples: async () => {
            throw new Error('replica timeout');
          },
        },
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [],
      },
      { pageSize: 10, maxAccounts: 10, minConfidence: 0 }
    );

    expect(result.reportsSent).toBe(1);
    expect(result.cohortSize).toBe(2);
    expect(out.reports[0].counters?.evidence_content_samples).toBe(0);
    expect(out.reports[0].summary).toContain('CONTENT SAMPLE DATA WAS UNAVAILABLE');
    // Not reported as an exhausted budget: that would send a grading pass looking for a cohort too
    // large rather than for a broken replica.
    expect(out.reports[0].counters?.evidence_content_budget_exhausted).toBe(0);
    expect(out.reports[0].counters?.evidence_members_sampled_for_content).toBe(0);
  });

  it('publishes evidence_content_samples as a 1 when the read worked', async () => {
    // Emitted on both sides, so the counter is a state rather than a flag that only ever appears in
    // the bad case.
    const { reader } = recordingReader([account(1)]);
    const out = sink();
    await runBotAccountDetection(
      {
        reader,
        evidence: {
          hasRegistrationIps: false,
          listRegistrationIps: async () => [],
          listContentSamples: async () => [],
        },
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [],
      },
      { pageSize: 10, maxAccounts: 10, minConfidence: 0 }
    );
    expect(out.reports[0].counters?.evidence_content_samples).toBe(1);
    expect(out.reports[0].summary).not.toContain('CONTENT SAMPLE DATA WAS UNAVAILABLE');
  });

  it('🔴 says the budget ran out, in the summary as well as the counters', async () => {
    // 🔴 The whole budget-exhausted sentence was unasserted: mutating `(signals.sources
    // .contentBudgetExhausted` to `(false` left the suite green, so half of what the PR body claims
    // the summary warns about was never checked. The sentence is pinned in full, not by keyword —
    // it names WHICH END went unsampled, and a reword that inverted that would pass a keyword test.
    const { reader } = recordingReader([account(1), account(2), account(3), account(4)]);
    const out = sink();
    await runBotAccountDetection(
      {
        reader,
        evidence: {
          hasRegistrationIps: false,
          listRegistrationIps: async () => [],
          // Two rows per chunk against a budget of 2: the first chunk spends it and the walk stops.
          listContentSamples: async (ids) =>
            ids.map((userId) => ({ userId, content: 'x'.repeat(30) })),
        },
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [],
      },
      { pageSize: 2, maxAccounts: 10, minConfidence: 0, maxContentSamples: 2 }
    );

    expect(out.reports[0].counters?.evidence_content_budget_exhausted).toBe(1);
    expect(out.reports[0].counters?.evidence_content_budget).toBe(2);
    expect(out.reports[0].summary).toContain(
      '🔴 THE CONTENT SAMPLE BUDGET (2 rows) WAS EXHAUSTED after 2 of 4 members. Members are ' +
        'sampled newest-first, so the unsampled remainder is the OLDEST end of the window and ' +
        'scored 0 on content templating for want of data.'
    );
  });
});

describe('the counters that make the heuristics’ own blind spots measurable', () => {
  it('🔴 counts the members whose email domain was SUPPRESSED as a common provider', async () => {
    // 🔴 `clustering.ts` asserted `domains_suppressed_common` "is what makes the first measurable"
    // while the identifier existed nowhere in `src/`, `packages/` or `apps/` — a comment claiming
    // coverage that did not exist, which is worse than no comment because it stops anyone looking.
    // It is the SIZE of the domain half's blind spot: a real ring that registered on a listed
    // provider scores 0 there by construction and nothing else can see it.
    const common = [1, 2, 3].map((id) => ({
      ...account(id),
      email: `u${id}@gmail.com`,
    }));
    const uncommon = [4, 5].map((id) => ({ ...account(id), email: `u${id}@ring.test` }));
    const { reader } = recordingReader([...common, ...uncommon]);
    const out = sink();
    const result = await runBotAccountDetection(
      { reader, sendReport: out.sendReport, now: clock(), heuristics: [] },
      { pageSize: 10, maxAccounts: 10, minConfidence: 0 }
    );

    expect(result.counters.domains_suppressed_common).toBe(3);
    expect(result.counters.cohort_size).toBe(5);
    // Emitted at zero too, on a cohort where nothing was suppressed — a counter that appears only
    // in the interesting case cannot be charted or alerted on.
    const clean = recordingReader(uncommon);
    const out2 = sink();
    const result2 = await runBotAccountDetection(
      { reader: clean.reader, sendReport: out2.sendReport, now: clock(), heuristics: [] },
      { pageSize: 10, maxAccounts: 10, minConfidence: 0 }
    );
    expect(result2.counters.domains_suppressed_common).toBe(0);
    expect(Object.keys(out2.reports[0].counters ?? {})).toContain('domains_suppressed_common');
  });

  it('🔴 counts the findings that rest on ONE heuristic and nothing else', async () => {
    // The counter the content-templating false positive shows up in. A generation-parameter paste
    // fires that heuristic and no other, so a run inflated by collisions moves
    // `heuristic:content-templating:sole_signal` and leaves `fired` looking ordinary. Over the
    // REPORTED members only: a sole signal below the threshold produced no finding and cost nobody
    // anything.
    const { reader } = recordingReader([account(1), account(2)]);
    const out = sink();
    const result = await runBotAccountDetection(
      {
        reader,
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [
          constantHeuristic('alone', 0.9),
          constantHeuristic('quiet', 0),
          constantHeuristic('silent', 0),
        ],
      },
      { pageSize: 10, maxAccounts: 10 }
    );

    expect(result.counters['heuristic:alone:sole_signal']).toBe(2);
    // Emitted as zeros for the heuristics that never fired alone, not omitted.
    expect(result.counters['heuristic:quiet:sole_signal']).toBe(0);
    expect(result.counters['heuristic:silent:sole_signal']).toBe(0);
  });

  it('does not count a finding TWO heuristics agreed on', async () => {
    // The negative control: `sole_signal` must mean "carried by one signal", not "fired". Without
    // this a counter wired to the same predicate as `fired` passes the case above.
    const { reader } = recordingReader([account(1)]);
    const out = sink();
    const result = await runBotAccountDetection(
      {
        reader,
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [constantHeuristic('a', 0.9), constantHeuristic('b', 0.9)],
      },
      { pageSize: 10, maxAccounts: 10 }
    );
    expect(result.counters['heuristic:a:evaluated']).toBe(1);
    expect(result.counters['heuristic:a:fired']).toBe(1);
    expect(result.counters['heuristic:a:sole_signal']).toBe(0);
    expect(result.counters['heuristic:b:sole_signal']).toBe(0);
  });

  it('counts only the REPORTED members, not every scored one', async () => {
    // A sole signal under the threshold produced no finding. Counting it would bury the number that
    // matters in the cohort's own size, which is the shape of every reassuring figure this detector
    // was built to avoid producing.
    const accounts = [account(1), account(2)];
    const { reader } = recordingReader(accounts);
    const out = sink();
    const result = await runBotAccountDetection(
      {
        reader,
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [
          {
            id: 'weak',
            description: 'test',
            weight: 1,
            // #2 blends to 0.9 and is reported; #1 blends to 0.01 and is not.
            score: ({ member }) => (member.userId === 2 ? 0.9 : 0.01),
            explain: () => null,
          },
        ],
      },
      { pageSize: 10, maxAccounts: 10 }
    );
    expect(result.findingsReported).toBe(1);
    expect(result.findingsSuppressed).toBe(1);
    expect(result.counters['heuristic:weak:fired']).toBe(2);
    expect(result.counters['heuristic:weak:sole_signal']).toBe(1);
  });
});

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

  it('🔴 reports accounts whose content is ALL gone, and counts how many there are', async () => {
    // 🔴 END TO END for F-2. Three accounts posted; two of them had every upload blocked. Before the
    // split those two were not in the cohort at all, so `cohortSize` was 1 and no counter, finding
    // or summary sentence in the whole run mentioned them.
    const scenario = run(
      [account(1), account(2), account(3)],
      {},
      undefined,
      new Set([2, 3]) // 40 uploads each, every one blocked
    );
    const result = await scenario.result;

    expect(result.cohortSize).toBe(3);
    expect(scenario.reports[0].findings.map((f) => f.userId)).toEqual([3, 2, 1]);
    // The blind-spot counter: how many of the cohort have nothing left on the site. Structurally
    // unobservable before, because those accounts were not members.
    expect(result.counters.cohort_members_nothing_on_site).toBe(2);
    // 40 + 40 + 1 posted, of which 40 + 40 are gone. Distinct from every other counter in the run.
    expect(result.counters.cohort_items_posted).toBe(81);
    expect(result.counters.cohort_items_not_on_site).toBe(80);
  });

  it('emits the blind-spot counters on a run where nothing was taken down', async () => {
    // Emitted at zero, not omitted. A counter that appears only in the bad case cannot be alerted
    // on, because its absence is indistinguishable from the producer not running at all.
    const scenario = run([account(1), account(2)]);
    const result = await scenario.result;
    expect(result.counters.cohort_members_nothing_on_site).toBe(0);
    expect(result.counters.cohort_items_not_on_site).toBe(0);
    expect(result.counters.cohort_items_posted).toBe(2);
    for (const key of [
      'cohort_members_nothing_on_site',
      'cohort_items_posted',
      'cohort_items_not_on_site',
    ])
      expect(Object.keys(scenario.reports[0].counters ?? {})).toContain(key);
  });

  it('says in the summary that membership counts everything an account posted', async () => {
    // The summary is what a grading pass reads first. "N had posted" against a visible-only
    // membership rule was a true sentence about a number that had quietly excluded the accounts
    // most worth looking at, so the rule is stated where the number is.
    const scenario = run([account(1), account(2)], {}, undefined, new Set([2]));
    await scenario.result;
    const summary = scenario.reports[0].summary ?? '';
    expect(summary).toContain('They posted 41 item(s), of which 40 are no longer on the site');
    expect(summary).toContain('1 of the 2 have nothing left on the site at all');
    expect(summary).toContain(
      'Membership counts everything an account posted, so an account whose uploads were all ' +
        'blocked or removed is included rather than dropped.'
    );
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
        {
          pageSize: 10,
          maxAccounts: 10,
          maxFindingsPerReport: 2,
          // 🔴 `heuristics: []` scores every member 0, which the DEFAULT threshold suppresses —
          // so without this the run produces one empty report and this case silently stops
          // exercising batching at all. `minConfidence: 0` is the documented full-cohort mode,
          // and it is what keeps this test about the thing it names rather than about the cut.
          minConfidence: 0,
        }
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
        {
          pageSize: 10,
          maxAccounts: 10,
          maxFindingsPerReport: 2,
          // 🔴 `heuristics: []` scores every member 0, which the DEFAULT threshold suppresses —
          // so without this the run produces one empty report and this case silently stops
          // exercising batching at all. `minConfidence: 0` is the documented full-cohort mode,
          // and it is what keeps this test about the thing it names rather than about the cut.
          minConfidence: 0,
        }
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
      {
        pageSize: 10,
        maxAccounts: 10,
        maxFindingsPerReport: 2,
        // 🔴 `heuristics: []` scores every member 0, which the DEFAULT threshold suppresses —
        // so without this the run produces one empty report and this case silently stops
        // exercising batching at all. `minConfidence: 0` is the documented full-cohort mode,
        // and it is what keeps this test about the thing it names rather than about the cut.
        minConfidence: 0,
      }
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

  it('never touches a write path on EITHER client', async () => {
    const scenario = run(Array.from({ length: 3 }, (_, i) => account(i + 1)));
    await scenario.result;
    // The behavioural half of the guard, against the REAL global `dbWrite` spy rather than a local
    // fake: it sees a write issued from anywhere in the run's import graph, including one this
    // module's own fakes know nothing about. The structural half — which sees a write that this
    // fixture's data happens not to reach — is `no-write-surface.test.ts`.
    //
    // 🔴 THE `dbRead` HALF IS NOT DECORATION. `packages/civitai-db/src/client.ts` builds `dbRead` as
    // `singleClient ? dbWrite : new PrismaClient(replica)`, so wherever `DATABASE_REPLICA_URL`
    // equals `DATABASE_URL` the two names are the SAME OBJECT and every raw statement below runs
    // against the primary. A list that named only `dbWrite.*` watched half the surface: the
    // demonstrated escape was `dbRead.$executeRawUnsafe('UPDATE "User" SET "muted" = true …')` in
    // `collectCohort`'s loop, which left this file entirely green.
    for (const client of ['dbWrite', 'dbRead'])
      for (const method of [
        'user.update',
        'user.updateMany',
        'user.create',
        'user.delete',
        'userRestriction.create',
        'userRestriction.update',
        '$transaction',
        '$executeRaw',
        '$executeRawUnsafe',
        '$queryRaw',
        '$queryRawUnsafe',
      ])
        expect(
          mockNode(`${client}.${method}`),
          `${client}.${method} was called by a shadow-mode run`
        ).not.toHaveBeenCalled();
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
