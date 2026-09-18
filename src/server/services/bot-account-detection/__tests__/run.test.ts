import {
  MAX_FINDINGS_PER_REPORT,
  abuseReportInput,
  type AbuseReportInput,
} from '@civitai/moderation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, mockNode } from '~/__tests__/mocks';
import type { BotAccountCohortMember, CohortReader, NewAccountRow } from '../cohort';
import { emptyCohortSignals } from '../evidence';
import { BOT_ACCOUNT_DETECTOR } from '../report';
import {
  BOT_ACCOUNT_HEURISTICS,
  assetStagingHeuristic,
  contentTemplatingHeuristic,
  postingVelocityHeuristic,
  registrationClusterHeuristic,
} from '../heuristics';
import { MIN_REPORTED_CONFIDENCE, soleSignalDominance, type BotAccountHeuristic } from '../scoring';
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
    // 🔴 THE CUT IS RENDERED EXACTLY. `toFixed(2)` printed the re-derived default 0.1125 as
    // `0.11` — a summary naming a looser cut than the one it applied, in the sentence a human reads
    // first. The expectation is the literal string, so a regression to two decimal places fails
    // here rather than being read past.
    expect(summary).toContain('1 scored at or above the 0.1125 reporting threshold');
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
   * A cohort of six accounts that share ONE registration IP and ONE uploaded filename, run end to
   * end through the PRODUCTION heuristic registry with a real `EvidenceReader` behind it.
   *
   * Six, not three: at the shipped boundaries six members on one address is where the IP ramp
   * reaches 0.5, and it overshoots `IP_ZERO_AT`/`CLUSTER_ZERO_AT` rather than sitting on them.
   */
  const RING_FILE = 'logo.jpg';
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
    listStagedImageSamples: async () => [],
    listFilenameSamples: async (ids: number[]) =>
      ids.map((userId) => ({ userId, name: RING_FILE })),
  };

  it('🔴 the cohort-level evidence REACHES the scoring, and the finding proves it', async () => {
    // 🔴 THE MUTANT THIS EXISTS FOR, AND IT IS THE MOST EXPENSIVE ONE IN THIS TREE. Replacing the
    // `signals` handed to `scoreAccount` with `emptyCohortSignals()` left the entire suite green:
    // `evidence.test.ts` covers the index, `heuristics.test.ts` covers the pure scorers over
    // hand-built signals, `run.test.ts` covered the threshold — and NO test ever built the combined
    // state. Two of the three heuristics would have scored 0 for every account on every production
    // run while `evidence_registration_ips`, `evidence_distinct_registration_ips` and
    // `evidence_distinct_filename_fingerprints` all reported healthy values, because those read
    // `signals` rather than what scoring saw. Half the detector inert, every counter saying it was
    // fine.
    //
    // The assertion is on the EMITTED FINDING's own sub-scores. A score object, or a counter, is a
    // claim about an intermediate; the finding is what reaches the board.
    const scenario = ringRun(ringEvidence);
    await scenario.result;

    const finding = scenario.reports[0].findings.find((f) => f.userId === 1);
    expect(finding).toBeDefined();
    const sub = subScoresOf(finding as { reason: string });

    // A positive control on the parse before either number is believed: all four registered
    // heuristics are present, so a regex that matched a fragment cannot read as a pass.
    expect(Object.keys(sub).sort()).toEqual([
      'asset-staging',
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
    // decoration on a number computed elsewhere. Two of FOUR heuristics at 0.5 blends to 0.25 —
    // it was 1/3 over three entries, and the difference is the denominator, not the evidence.
    expect(finding?.confidence).toBeCloseTo(0.25, 6);

    // The reason a moderator reads names WHAT was seen, not only that something was.
    expect(finding?.reason).toContain('6 new posting accounts share its registration IP');
    expect(finding?.reason).toContain('6 new accounts uploaded a file with the same name');
  });

  it('🔴 A SHARED FILENAME ALONE REACHES THE BOARD, with no comments anywhere in the run', async () => {
    // 🔴 THE END-TO-END CASE, and the one no component test can make. `evidence.test.ts` covers
    // the index and `heuristics.test.ts` covers the scorer over hand-built signals; neither ever
    // builds the combined state, which is how a source that fired ZERO times in every run it
    // shipped in kept looking healthy inside an aggregate counter. This run has no registration-IP
    // data either, so the finding rests on the filename cluster alone.
    const scenario = ringRun({
      hasRegistrationIps: false,
      listRegistrationIps: async () => [],
      // Mixed case on purpose: these are ONE cluster, not two.
      listStagedImageSamples: async () => [],
      listFilenameSamples: async (ids: number[]) =>
        ids.map((userId) => ({ userId, name: userId % 2 === 0 ? 'Logo.jpg' : 'logo.jpg' })),
    });
    const result = await scenario.result;

    const finding = scenario.reports[0].findings.find((f) => f.userId === 1);
    expect(finding).toBeDefined();
    const sub = subScoresOf(finding as { reason: string });
    expect(Object.keys(sub).sort()).toEqual([
      'asset-staging',
      'content-templating',
      'posting-velocity',
      'registration-cluster',
    ]);

    // The templating heuristic fired, carrying the finding with every other source dark.
    expect(sub['content-templating']).toBeGreaterThan(0);
    // And the reason names it as a FILENAME and quotes the PLAIN name, not the namespaced key.
    expect(finding?.reason).toContain('uploaded a file with the same name');
    expect(finding?.reason).toContain('logo.jpg');
    expect(finding?.reason).not.toContain('file:logo.jpg');

    // 🔴 THE DECOMPOSITION. Without a per-source counter the shadow phase cannot grade sources
    // apart, which is precisely how the deleted comment source survived every run looking fine
    // inside an aggregate.
    expect(result.counters['heuristic:content-templating:fired_filename']).toBeGreaterThan(0);

    // 🔴 AND WITH ONE SOURCE LEFT IT IS EQUAL TO `fired`, WHICH IS THE HONEST THING TO PIN. An
    // invariant tripwire, not regression coverage: `fired` counts the same members over every
    // namespace and this counts them over `file:`, so while the index holds one namespace the two
    // are the same number and charting both shows an operator nothing. The assertion above is the
    // positive control that stops this one passing as `0 === 0`. The namespace count itself is
    // pinned in `evidence.test.ts`; between them, the note in `run.ts` cannot go stale unobserved.
    expect(result.counters['heuristic:content-templating:fired_filename']).toBe(
      result.counters['heuristic:content-templating:fired']
    );

    // 🔴 THE DELETED SOURCE'S KEYS ARE ABSENT, NOT ZERO. A key that stops appearing says "not
    // read any more"; a key reporting 0 would assert the source was read and found nothing. Asserted
    // as ABSENCE because the counters object is what a run series is built from, and a stale zero is
    // the shape every reassuring-zero defect in this module has taken.
    expect(Object.keys(result.counters)).not.toContain('heuristic:content-templating:fired_text');
    expect(Object.keys(result.counters)).not.toContain('evidence_distinct_content_fingerprints');
    expect(Object.keys(result.counters)).not.toContain('evidence_content_samples');
    expect(Object.keys(result.counters)).not.toContain('evidence_content_read_failed');
    expect(Object.keys(result.counters)).not.toContain('evidence_content_budget');
    expect(Object.keys(result.counters)).not.toContain('evidence_content_budget_exhausted');
    expect(Object.keys(result.counters)).not.toContain('evidence_members_sampled_for_content');
    // The positive control on those seven: the counters object is populated, so `not.toContain` is
    // not passing over an empty list.
    expect(Object.keys(result.counters).length).toBeGreaterThan(20);
    expect(result.counters.evidence_distinct_filename_fingerprints).toBe(1);
    expect(result.counters.evidence_filename_samples).toBe(1);
  });

  it('🔴 the filename source is reported UNAVAILABLE when the read fails, not as a quiet zero', async () => {
    // A zero from a source that never ran is not a zero from a source that found nothing, and the
    // counter plus the summary sentence are the only things that tell a reader which one this is.
    const scenario = ringRun({
      hasRegistrationIps: false,
      listRegistrationIps: async () => [],
      listStagedImageSamples: async () => [],
      listFilenameSamples: async () => {
        throw new Error('replica timeout');
      },
    });
    const result = await scenario.result;
    expect(result.counters.evidence_filename_samples).toBe(0);
    expect(scenario.reports[0].summary).toContain('THE UPLOADED-FILENAME READ FAILED');
    // The run still completed and still filed a report — a dead source degrades it, never kills it.
    expect(result.reportsSent).toBeGreaterThan(0);
  });

  it('🔴 A FAILED FILENAME READ AND A QUIET DAY PRODUCE DIFFERENT COUNTERS', async () => {
    // 🔴 THE SEAM THIS WHOLE CHANGE EXISTS FOR, ASSERTED AS A COMPARISON RATHER THAN AS A VALUE.
    // A production run's filename read failed on every attempt and the run reported success. Its
    // counters — `evidence_filename_samples: 0`, `evidence_members_sampled_for_filenames: 0`,
    // `evidence_distinct_filename_fingerprints: 0`, `evidence_filename_budget_exhausted: 0` — were
    // number for number the counters of a day on which nobody uploaded anything. Nothing alerted,
    // every dashboard was green, and the only record was one log line. A test asserting any single
    // counter's VALUE would have passed on both runs; only asserting that the two runs DIFFER
    // states the property that was missing.
    const failed = ringRun({
      hasRegistrationIps: false,
      listRegistrationIps: async () => [],
      listStagedImageSamples: async () => [],
      listFilenameSamples: async () => {
        throw new Error('replica timeout');
      },
    });
    const failedCounters = (await failed.result).counters;

    // The control: the identical run whose filename read worked perfectly and found nothing.
    const quiet = ringRun({
      hasRegistrationIps: false,
      listRegistrationIps: async () => [],
      listStagedImageSamples: async () => [],
      listFilenameSamples: async () => [],
    });
    const quietCounters = (await quiet.result).counters;

    // The two counter maps differ. ⚠️ LABELLED HONESTLY: this line alone is an INVARIANT GUARD, not
    // regression coverage — it passes on the pre-change code too, because on a non-empty cohort
    // with a working reader `evidence_filename_samples` and
    // `evidence_members_sampled_for_filenames` already separated these two runs. It is kept because
    // it is the property a reader will look for; the coverage is in the two blocks below.
    expect(failedCounters).not.toEqual(quietCounters);

    // 🔴 REGRESSION COVERAGE STARTS HERE: this key does not exist on the pre-change code. Asserted
    // in BOTH directions — a counter only ever asserted non-zero could be hardcoded non-zero and
    // still pass.
    expect(failedCounters.evidence_source_read_failures).toBe(1);
    expect(quietCounters.evidence_source_read_failures).toBe(0);
    expect(failedCounters.evidence_filename_read_failed).toBe(1);
    expect(quietCounters.evidence_filename_read_failed).toBe(0);

    // 🔴 EMITTED ON EVERY RUN, ZEROS INCLUDED. A key that is absent on a healthy run cannot be
    // alerted on with a threshold — the absence reads as "no data", not as "nothing broke".
    expect(Object.keys(quietCounters)).toContain('evidence_source_read_failures');
    expect(Object.keys(quietCounters)).toContain('evidence_filename_read_failed');
    expect(Object.keys(quietCounters)).toContain('evidence_staged_image_read_failed');
    expect(Object.keys(quietCounters)).toContain('evidence_registration_ips_read_failed');

    // ⚠️ TWO COUNTERS THIS ASSERTION FIRST OVERCLAIMED, CORRECTED BY WATCHING IT FAIL RATHER THAN
    // BY REASONING. `evidence_filename_samples` and `evidence_members_sampled_for_filenames` DO
    // separate a failed read from a quiet day on a non-empty cohort (0 vs 1, and 0 vs 6). Only
    // these two carry no information at all, and saying more than that would be the same kind of
    // claim-wider-than-the-code this file keeps finding:
    for (const key of [
      'evidence_distinct_filename_fingerprints',
      'evidence_filename_budget_exhausted',
    ])
      expect(failedCounters[key]).toBe(quietCounters[key]);

    // 🔴 THE THIRD ARM, AND THE ONE THAT MATCHES THE PRODUCTION INCIDENT: a run with NO evidence
    // reader at all — the source never ran. EVERY filename counter is byte-identical to the failed
    // run's, which is precisely why the report sentence used to have to say "the read either did
    // not run or failed": nothing published could choose between them. The new key chooses.
    const neverRan = run([account(1)]);
    await neverRan.result;
    const absentCounters = neverRan.reports[0].counters ?? {};
    for (const key of [
      'evidence_filename_samples',
      'evidence_members_sampled_for_filenames',
      'evidence_distinct_filename_fingerprints',
      'evidence_filename_budget_exhausted',
      'evidence_filename_budget',
    ])
      expect([key, absentCounters[key]]).toEqual([key, failedCounters[key]]);
    expect(absentCounters.evidence_source_read_failures).toBe(0);
    expect(failedCounters.evidence_source_read_failures).toBe(1);
  });

  /**
   * A cohort whose accounts have uploaded images and published NONE of them — the shape
   * `asset-staging` exists to see. `visible: 0` on every member, because a staged image is
   * unattached by definition and `imageCountArgs` excludes it.
   */
  const stagingRun = (
    evidence: Parameters<typeof runBotAccountDetection>[0]['evidence'],
    images = 6
  ) => {
    const accounts = Array.from({ length: 3 }, (_, i) => account(i + 1));
    const reader: CohortReader = {
      listNewAccounts: async ({ before, take }) =>
        [...accounts]
          .sort((a, b) => b.id - a.id)
          .filter((a) => before === undefined || a.id < before)
          .slice(0, take),
      countPosts: async (ids) => ({
        comments: [],
        commentsV2: [],
        models: [],
        images: [],
        allComments: [],
        allCommentsV2: [],
        allModels: [],
        allImages: ids.map((userId) => ({ userId, count: images })),
      }),
    };
    const out = sink();
    return {
      ...out,
      result: runBotAccountDetection(
        { reader, evidence, sendReport: out.sendReport, now: clock() }, // production registry
        { pageSize: 10, maxAccounts: 10, minConfidence: 0 }
      ),
    };
  };

  /** Staged uploads for every member, `perMember` of them, all inside ONE second when `burst`. */
  const stagedEvidence = (perMember: number, burst: boolean) => ({
    hasRegistrationIps: false,
    listRegistrationIps: async () => [],
    listFilenameSamples: async () => [],
    listStagedImageSamples: async (ids: number[]) =>
      ids.flatMap((userId) =>
        Array.from({ length: perMember }, (_, i) => ({
          userId,
          createdAt: new Date(
            new Date('2026-09-03T02:00:00.000Z').getTime() + (burst ? i * 10 : i * 60_000)
          ),
        }))
      ),
  });

  it('🔴 THE STAGED EVIDENCE REACHES THE SCORING, and the finding proves it', async () => {
    // 🔴 THE SEAM, AND IT IS THE ONE THIS TREE HAS ALREADY BEEN BURNED BY. `evidence.test.ts` covers
    // the index, `heuristics.test.ts` covers the scorer over hand-built signals — and neither ever
    // builds the COMBINED state, which is exactly how a mutant replacing the `signals` handed to
    // `scoreAccount` with `emptyCohortSignals()` once left an entire suite green with two-thirds of
    // the detector inert. A fourth heuristic reading a fourth index is a fourth chance at that, and
    // the cheapest place to lose it is the one wire nobody tests: `collectCohortSignals` building
    // `stagedImagesByUser`, and `scoreAccount` being handed THAT object.
    //
    // The assertion is on the EMITTED FINDING's sub-scores. A score object or a counter is a claim
    // about an intermediate; the finding is what reaches the board.
    const scenario = stagingRun(stagedEvidence(2, false));
    await scenario.result;

    const finding = scenario.reports[0].findings.find((f) => f.userId === 1);
    expect(finding).toBeDefined();
    const sub = subScoresOf(finding as { reason: string });
    // Positive control on the parse before any number is believed.
    expect(Object.keys(sub).sort()).toEqual([
      'asset-staging',
      'content-templating',
      'posting-velocity',
      'registration-cluster',
    ]);

    // 🔴 THE HEURISTIC THAT GOES INERT UNDER THE SEAM MUTANT, AT ITS FIRING POINT. TWO staged
    // uploads a minute apart saturates the volume half at 1 and scores nothing on the burst half.
    // Read off the reason's `id=0.00` clause, so the expectation is the RENDERED two-decimal form —
    // which is what a moderator sees. ⚠️ Do not read the exact matcher as buying precision: the
    // sub-score is rendered with `toFixed(2)` before `subScoresOf` parses it back, so the renderer
    // sets the resolution and a heuristic scoring 0.999 renders `1.00` and passes this line. What
    // discriminates a near-miss is the confidence assertion below, on its own — measured, a
    // `score * 0.999` mutant reaches it and fails with `expected 0.24975 to be close to 0.25`. The
    // `count: 1` control at the foot of this case catches a constant CEILING, which is a different
    // mutant; it does not see a near-miss, and an earlier wording here credited it with both.
    //
    // 🔴 THIS EXPECTATION IS NOW THE HEURISTIC'S CEILING, AND THAT USED TO BE DELIBERATELY AVOIDED
    // HERE. While the volume ramp rose to a boundary of 3, two uploads landed mid-ramp at 0.5, and
    // a mid-ramp value separates "the evidence arrived" from "the heuristic returns its ceiling".
    // The ramp now saturates AT the firing point (see `STAGED_ONE_AT`), so no count this fixture
    // can carry is mid-ramp and that separation is no longer available from one run. It is restored
    // below by a second run at a count the heuristic must score ZERO on: a mutant returning a
    // constant ceiling fails there, which is the property this case would otherwise have lost.
    expect(sub['asset-staging']).toBe(1);
    // 🔴 AND THE THREE RING HEURISTICS SCORE NOTHING, which is the point of the case: this account
    // is on the board because of its OWN uploads, with no other account involved anywhere in the
    // run. No previous heuristic could have produced this finding.
    expect(sub['posting-velocity']).toBe(0);
    expect(sub['registration-cluster']).toBe(0);
    expect(sub['content-templating']).toBe(0);
    // 🔴 AND THE FIRING POINT ITSELF, THROUGH THE WHOLE RUN. One of four heuristics at 1 blends to
    // 0.25, against a shipped cut of 0.1125 — so two staged uploads is a row a moderator actually
    // receives. `heuristics.test.ts` pins the same property against the registry and the partition
    // directly; this asserts it survives the run's real reader, evidence layer, scorer and report
    // rendering, which is the composition no unit case builds.
    expect(finding?.confidence).toBeCloseTo(0.25, 12);
    expect(finding?.confidence as number).toBeGreaterThanOrEqual(MIN_REPORTED_CONFIDENCE);
    // ⚠️ The `findingsReported` line is a cohort-size check, NOT part of the firing-point claim —
    // this scenario runs with `minConfidence: 0`, so every scored member is emitted whatever it
    // scored and this count cannot distinguish a reported account from a suppressed one. What
    // carries "a row a moderator actually receives" is the `>= MIN_REPORTED_CONFIDENCE` line above.
    expect((await scenario.result).findingsReported).toBe(3);

    // The reason names WHAT was seen, not merely that something was.
    expect(finding?.reason).toContain('no generation metadata');
    expect(finding?.reason).toContain('attached to no post');

    // 🔴 THE NEGATIVE CONTROL THE SATURATED EXPECTATION ABOVE COSTS THIS CASE OTHERWISE. Same run,
    // same wiring, ONE staged upload per member instead of two — below the firing point, so the
    // heuristic must score nothing. A mutant that returns the heuristic's ceiling without reading
    // the evidence passes every assertion above and fails here.
    //
    // Asserted on the SUB-SCORE and the confidence rather than on `findingsReported`: this scenario
    // runs with `minConfidence: 0`, so every scored member is emitted whatever it scored, and a
    // finding count would be measuring the option rather than the heuristic.
    const below = stagingRun(stagedEvidence(1, false));
    await below.result;
    const belowFinding = below.reports[0].findings.find((f) => f.userId === 1);
    expect(belowFinding).toBeDefined();
    expect(subScoresOf(belowFinding as { reason: string })['asset-staging']).toBe(0);
    expect(belowFinding?.confidence).toBe(0);
  });

  it('🔴 the SAME-SECOND half moves the COUNTERS and NOT the score — the arm is inert, not absent', async () => {
    // Two runs, identical but for WHEN the uploads happened.
    //
    // 🔴 THIS CASE USED TO ASSERT THE OPPOSITE, AND THE CHANGE IS THE POINT. While the burst
    // boundaries sat tighter than the volume ones (4 against 8) the same-second run scored HIGHER
    // on the board, and this case pinned that. A same-second group is a SUBSET of the staged rows
    // and the volume ramp is at or above the burst ramp at every input, so the burst half can never
    // exceed the volume half and `max` resolves to `volume` for every account. The honest statement
    // is therefore an EQUALITY on the score and a DIFFERENCE on the counters, and writing it the
    // old way would be a guard asserting behaviour the shipped code does not have.
    //
    // 🔴 THE EQUALITY IS AT SATURATION NOW, AND THAT WEAKENS IT — SAID HERE RATHER THAN LEFT IN THE
    // GREEN. The volume ramp saturates at the firing point (see `STAGED_ONE_AT`), so there is no
    // count at which these two runs could be compared mid-ramp, and a mutant that saturated a half
    // would land on the same 1. The DISCRIMINATION MOVED TO THE COUNTERS, which is also where the
    // arm's only remaining product is: the spread run must report `fired_burst` 0 against
    // `fired_volume` 3, which a burst half that saturated or ignored its boundary cannot do.
    const spread = stagingRun(stagedEvidence(2, false));
    const spreadResult = await spread.result;
    const burst = stagingRun(stagedEvidence(2, true));
    const burstResult = await burst.result;

    const scoreOf = (s: typeof spread) =>
      subScoresOf(s.reports[0].findings.find((f) => f.userId === 1) as { reason: string })[
        'asset-staging'
      ];
    // Rendered to two decimals in the reason clause: the volume half saturates at its boundary of
    // two in BOTH runs, and the burst half contributes nothing visible even when it is fully
    // engaged. A mutant that zeroed the VOLUME half fails here — `scoreOf` reads 0 out of the
    // rendered reason clause against an expected 1. (NOT because the finding would disappear: this
    // scenario runs with `minConfidence: 0`, so a member scoring 0 is still emitted, which the
    // negative control in the sibling case relies on.) 🔴 A mutant that zeroed the BURST half does
    // NOT fail here — `max` is identically `volume`, so `scoreOf` still reads 1 and both lines pass;
    // its first failure is the `fired_burst` counter below. Nor does one that saturates either half.
    // That is precisely why the counters carry this case rather than these two lines.
    expect(scoreOf(spread)).toBe(1);
    expect(scoreOf(burst)).toBe(1);

    // 🔴 THE COUNTERS ARE WHERE THE BURST HALF STILL EXISTS, AND THEY ARE NOW ITS ONLY PRODUCT
    // BESIDES THE MODERATOR CLAUSE. This is what the shadow phase reads to answer whether
    // same-second concentration separates at all — and therefore whether the arm should be
    // re-shaped or deleted — NOT "re-tightened below the volume boundary", which this sentence said
    // until the volume ramp became a step at two. A tighter `BURST_ONE_AT` no longer moves any
    // score. (It is NOT impossible, which an earlier wording of this correction claimed: a burst
    // pair of (0, 1) is a legal pair strictly below the volume boundary and does revive the arm —
    // by dropping `zeroAt`, which is what breaks the dominance, not by tightening `oneAt`. See
    // `BURST_ONE_AT`.) Without the decomposition that question
    // has no number behind it, which is the failure that kept a zero-firing comment source alive
    // for five runs one heuristic over.
    expect(burstResult.counters['heuristic:asset-staging:fired_burst']).toBe(3);
    expect(burstResult.counters['heuristic:asset-staging:fired_volume']).toBe(3);
    expect(spreadResult.counters['heuristic:asset-staging:fired_burst']).toBe(0);
    expect(spreadResult.counters['heuristic:asset-staging:fired_volume']).toBe(3);
  });

  it('🔴 A FAILED STAGED READ AND A QUIET DAY PRODUCE DIFFERENT COUNTERS', async () => {
    // 🔴 THE SILENT-ZERO SEAM, ON THE SOURCE WHERE THE QUIET-DAY READING IS NOT MERELY WEAKER BUT
    // FALSE. A dead staged read leaves `asset-staging` asserting that every account published what
    // it uploaded. Asserted as a COMPARISON between two runs rather than as a value, because a test
    // pinning any single counter's value passes on BOTH of them — which is exactly how a production
    // run whose image read died on every attempt reported success with every dashboard green.
    const failed = stagingRun({
      hasRegistrationIps: false,
      listRegistrationIps: async () => [],
      listFilenameSamples: async () => [],
      listStagedImageSamples: async () => {
        throw new Error('replica timeout');
      },
    });
    const failedCounters = (await failed.result).counters;
    // The control: the identical run whose staged read worked perfectly and found nothing.
    const quiet = stagingRun({
      hasRegistrationIps: false,
      listRegistrationIps: async () => [],
      listFilenameSamples: async () => [],
      listStagedImageSamples: async () => [],
    });
    const quietCounters = (await quiet.result).counters;

    expect(failedCounters.evidence_staged_image_read_failed).toBe(1);
    expect(quietCounters.evidence_staged_image_read_failed).toBe(0);
    expect(failedCounters.evidence_source_read_failures).toBe(1);
    expect(quietCounters.evidence_source_read_failures).toBe(0);
    expect(failedCounters.evidence_staged_images).toBe(0);
    expect(quietCounters.evidence_staged_images).toBe(1);
    // 🔴 EMITTED ON EVERY RUN, ZEROS INCLUDED — a key absent on a healthy run cannot be alerted on
    // with a threshold, because its absence reads as "no data" rather than as "nothing broke".
    for (const key of [
      'evidence_staged_images',
      'evidence_staged_image_read_failed',
      'evidence_members_with_staged_images',
      'evidence_staged_image_budget_exhausted',
      'evidence_staged_image_budget',
    ])
      expect(Object.keys(quietCounters)).toContain(key);

    // And the summary says WHICH of the two happened, in the sentence a human reads first.
    expect(failed.reports[0].summary).toContain('THE STAGED-IMAGE READ FAILED');
    expect(quiet.reports[0].summary).not.toContain('STAGED-IMAGE');
  });

  it('🔴 a run with NO evidence reader says the staged source did not run, not that it failed', async () => {
    // The third arm, and the one the counters alone cannot separate from a failure: a deployment
    // where the source was never wired up is a normal state, not an incident. The two sentences
    // call for different actions and only the report chooses between them.
    const neverRan = run([account(1)]);
    const result = await neverRan.result;
    expect(result.counters.evidence_staged_images).toBe(0);
    expect(result.counters.evidence_staged_image_read_failed).toBe(0);
    const summary = neverRan.reports[0].summary ?? '';
    expect(summary).toContain('STAGED-IMAGE DATA WAS UNAVAILABLE');
    expect(summary).not.toContain('THE STAGED-IMAGE READ FAILED');
  });

  it('counts the members carrying any staged upload — the heuristic’s own denominator', async () => {
    // A rate is unreadable without it: "nobody scored" means one thing when six members staged
    // something and another when none did, and no other counter separates those.
    const scenario = stagingRun(stagedEvidence(2, false));
    const counters = (await scenario.result).counters;
    expect(counters.evidence_members_with_staged_images).toBe(3);
    // The negative arm, so the number is not simply the cohort size under another name.
    const none = stagingRun({
      hasRegistrationIps: false,
      listRegistrationIps: async () => [],
      listFilenameSamples: async () => [],
      listStagedImageSamples: async () => [],
    });
    expect((await none.result).counters.evidence_members_with_staged_images).toBe(0);
    expect((await none.result).counters.cohort_size).toBe(3);
  });

  it('🔴 a healthy run reports ZERO read failures — the other arm of the same key', async () => {
    // A failure counter that is never watched going to zero is a counter nobody can trust a zero
    // from. This arm is what makes the non-zero above attributable.
    const scenario = ringRun({
      hasRegistrationIps: true,
      listRegistrationIps: async () => [],
      listStagedImageSamples: async () => [],
      listFilenameSamples: async () => [],
    });
    const counters = (await scenario.result).counters;
    expect(counters.evidence_source_read_failures).toBe(0);
    expect(counters.evidence_registration_ips_read_failed).toBe(0);
    expect(counters.evidence_filename_read_failed).toBe(0);
    expect(counters.evidence_staged_image_read_failed).toBe(0);
    expect(scenario.reports[0].summary).not.toContain('READ FAILED');
  });

  it('🔴 several sources failing are COUNTED, not collapsed to a boolean', async () => {
    // The aggregate has to be a count for a reader to tell one broken source from all of them —
    // the run where everything went is not the same incident as the run where one did.
    const scenario = ringRun({
      hasRegistrationIps: true,
      listRegistrationIps: async () => {
        throw new Error('clickhouse down');
      },
      listStagedImageSamples: async () => {
        throw new Error('replica timeout');
      },
      listFilenameSamples: async () => {
        throw new Error('replica timeout');
      },
    });
    const counters = (await scenario.result).counters;
    expect(counters.evidence_source_read_failures).toBe(3);
    // Asserted per source as well as in aggregate, so a count of three cannot be reached by one
    // source's failure being recorded three times.
    expect(counters.evidence_registration_ips_read_failed).toBe(1);
    expect(counters.evidence_filename_read_failed).toBe(1);
    expect(counters.evidence_staged_image_read_failed).toBe(1);
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
    // Three of the four heuristics score 0 when their source is missing, which is byte-identical to
    // scoring 0 because nothing was found. These counters are the only things that tell the two
    // apart — without them a grading pass averages blind runs in as evidence of no rings.
    const scenario = run([account(1)]);
    await scenario.result;
    const counters = scenario.reports[0].counters ?? {};
    expect(counters.evidence_registration_ips).toBe(0);
    expect(counters.evidence_filename_samples).toBe(0);
    expect(counters.evidence_filename_budget_exhausted).toBe(0);
    expect(counters.evidence_members_sampled_for_filenames).toBe(0);
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
          listStagedImageSamples: async () => [],
          listFilenameSamples: async () => [],
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
    expect(counters.evidence_filename_samples).toBe(1);
    expect(counters.evidence_members_sampled_for_filenames).toBe(2);
  });

  it('warns in the summary when the IP source DID NOT RUN, and says which of the two it was', async () => {
    // 🔴 STRENGTHENED FROM A SUBSTRING BOTH BRANCHES SPELL. This used to assert only
    // `'REGISTRATION-IP DATA WAS UNAVAILABLE'`, which is present in the did-not-run branch AND in
    // the read-failed branch — so the one distinguishing clause this PR adds to the IP sentence
    // could be deleted with this test still green (mutation: the failure condition forced to
    // `false`; the suite stayed 362/362). The whole normalised sentence is pinned instead, because
    // a guard on a word the other branch also spells is walkable by construction.
    const scenario = run([account(1)]);
    await scenario.result;
    expect(scenario.reports[0].summary).toContain(
      '🔴 REGISTRATION-IP DATA WAS UNAVAILABLE this run, so the clustering heuristic scored on ' +
        'email domain alone — a low score from it is not evidence that accounts share no IP.'
    );
    // No ClickHouse client is a normal deployment, not an incident: the failure clause must be
    // absent, and the counter with it.
    expect(scenario.reports[0].summary).not.toContain('BECAUSE THE READ FAILED');
    expect(scenario.reports[0].counters?.evidence_source_read_failures).toBe(0);
  });

  it('🔴 says the IP read FAILED, in the clause that separates a broken read from an absent client', async () => {
    // 🔴 THE SOURCE ON WHICH "UNAVAILABLE" IS ALSO A NORMAL STEADY STATE. Every deployment without
    // ClickHouse configured prints "REGISTRATION-IP DATA WAS UNAVAILABLE" on every run, forever —
    // so on this one source the word a moderator reads carries no information at all, and the
    // failure clause is the entire disclosure. With it deleted, a broken ClickHouse read is
    // indistinguishable from the deployment that never had one, which is the exact ambiguity this
    // PR exists to remove.
    //
    // The full sentence, not a keyword: the two branches differ only by the inserted clause.
    const { reader } = recordingReader([account(1), account(2)]);
    const out = sink();
    await runBotAccountDetection(
      {
        reader,
        evidence: {
          hasRegistrationIps: true,
          listRegistrationIps: async () => {
            throw new Error('clickhouse down');
          },
          listStagedImageSamples: async () => [],
          listFilenameSamples: async () => [],
        },
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [],
      },
      { pageSize: 10, maxAccounts: 10, minConfidence: 0 }
    );

    expect(out.reports[0].summary).toContain(
      '🔴 REGISTRATION-IP DATA WAS UNAVAILABLE this run BECAUSE THE READ FAILED (counted in ' +
        'evidence_source_read_failures), so the clustering heuristic scored on email domain alone ' +
        '— a low score from it is not evidence that accounts share no IP.'
    );
    // And the counter it names is actually non-zero, so the sentence points somewhere real.
    expect(out.reports[0].counters?.evidence_source_read_failures).toBe(1);
    // The run still degraded rather than died.
    expect(out.reports[0].counters?.cohort_size).toBe(2);
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
          listStagedImageSamples: async () => [],
          listFilenameSamples: async () => [],
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
          listStagedImageSamples: async () => [],
          listFilenameSamples: async () => [],
        },
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [],
      },
      { pageSize: 10, maxAccounts: 10, minConfidence: 0 }
    );
    expect(out.reports[0].summary).not.toContain('MATCHED NOTHING');
  });

  it('🔴 a failing FILENAME read degrades the run: a report is still filed, and it SAYS so', async () => {
    // 🔴 THE FAILURE THIS EXISTS TO PREVENT, END TO END. Before the Postgres reads were guarded, a
    // replica timeout propagated out of the run and NO REPORT WAS FILED AT ALL — the velocity
    // heuristic's day lost with it, and the whole thing indistinguishable from a producer that
    // stopped running. Under unguarded code this case does not fail an assertion, it REJECTS.
    const { reader } = recordingReader([account(1), account(2)]);
    const out = sink();
    const result = await runBotAccountDetection(
      {
        reader,
        evidence: {
          hasRegistrationIps: false,
          listRegistrationIps: async () => [],
          listStagedImageSamples: async () => [],
          listFilenameSamples: async () => {
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
    expect(out.reports[0].counters?.evidence_filename_samples).toBe(0);
    // 🔴 IT NAMES A FAILURE, NOT AN ABSENCE. The sentence used to read "the read either did not run
    // or failed", which is one sentence covering two situations with different remedies — an
    // unwired deployment and a broken read that needs fixing today.
    expect(out.reports[0].summary).toContain('THE UPLOADED-FILENAME READ FAILED');
    expect(out.reports[0].counters?.evidence_filename_read_failed).toBe(1);
    // Not reported as an exhausted budget: that would send a grading pass looking for a cohort too
    // large rather than for a broken replica.
    expect(out.reports[0].counters?.evidence_filename_budget_exhausted).toBe(0);
    expect(out.reports[0].counters?.evidence_members_sampled_for_filenames).toBe(0);
  });

  it('publishes evidence_filename_samples as a 1 when the read worked', async () => {
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
          listStagedImageSamples: async () => [],
          listFilenameSamples: async () => [],
        },
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [],
      },
      { pageSize: 10, maxAccounts: 10, minConfidence: 0 }
    );
    expect(out.reports[0].counters?.evidence_filename_samples).toBe(1);
    expect(out.reports[0].summary).not.toContain('UPLOADED-FILENAME DATA WAS UNAVAILABLE');
    expect(out.reports[0].summary).not.toContain('THE UPLOADED-FILENAME READ FAILED');
  });

  it('🔴 the DID-NOT-RUN half of both disclosures, pinned whole and pinned APART from the FAILED half', async () => {
    // 🔴 THE UNTESTED HALF OF THE SENTENCE THIS PR SPLIT IN TWO. Every existing case drives the
    // FAILED branch; nothing asserted the other one, so the two texts could be SWAPPED and the
    // suite stayed 362/362 (mutation: the did-not-run branch made to emit the FAILED text). The
    // damage of that swap is the PR's own motivating failure inverted — a deployment with no
    // evidence reader at all would tell a moderator "THE UPLOADED-FILENAME READ FAILED this run …
    // it is a broken read", sending someone to chase a healthy replica that was never asked
    // anything.
    //
    // A run with NO evidence reader: `emptyCohortSignals()` sets every availability flag false and
    // every `readFailures` flag false, which is exactly the did-not-run state.
    const scenario = run([account(1)]);
    await scenario.result;
    const summary = scenario.reports[0].summary ?? '';

    expect(summary).toContain(
      '🔴 UPLOADED-FILENAME DATA WAS UNAVAILABLE this run — the read did not run — so the ' +
        'content-templating heuristic scored 0 for every member for want of ' +
        'data. That is not evidence that no accounts uploaded files under the same name.'
    );
    expect(summary).toContain(
      '🔴 STAGED-IMAGE DATA WAS UNAVAILABLE this run — the read did not run — so the ' +
        'asset-staging heuristic scored 0 for every member for want of data. That is not evidence ' +
        'that these accounts published what they uploaded.'
    );

    // 🔴 DISTINGUISHABLE FROM, NOT MERELY PRESENT. "The sentence is there" is true of the mutant
    // too — it is the wrong sentence being there that does the harm — so the claim has to be that
    // the FAILED text is ABSENT, and that the counters agree with the words.
    expect(summary).not.toContain('THE UPLOADED-FILENAME READ FAILED');
    expect(summary).not.toContain('THE STAGED-IMAGE READ FAILED');
    expect(summary).not.toContain('it is a broken read');
    expect(scenario.reports[0].counters?.evidence_source_read_failures).toBe(0);
    expect(scenario.reports[0].counters?.evidence_staged_image_read_failed).toBe(0);
    expect(scenario.reports[0].counters?.evidence_filename_read_failed).toBe(0);
  });

  it('🔴 says the budget ran out, in the summary as well as the counters', async () => {
    // 🔴 The whole budget-exhausted sentence was unasserted for a long while: mutating the guard to
    // a constant `false` left the suite green, so half of what the summary claims to warn about was
    // never checked. The sentence is pinned in full, not by keyword — it names WHICH END went
    // unsampled, and a reword that inverted that would pass a keyword test.
    //
    // Twelve members at `filenameBatchSize` 10 (the production default) against a budget of 2: the
    // first batch of ten spends it and the walk stops before the second, leaving 2 of 12 unsampled.
    const accounts = Array.from({ length: 12 }, (_, i) => account(i + 1));
    const { reader } = recordingReader(accounts);
    const out = sink();
    await runBotAccountDetection(
      {
        reader,
        evidence: {
          hasRegistrationIps: false,
          listRegistrationIps: async () => [],
          listStagedImageSamples: async () => [],
          listFilenameSamples: async (ids) => ids.map((userId) => ({ userId, name: 'a.png' })),
        },
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [],
      },
      { pageSize: 20, maxAccounts: 20, minConfidence: 0, maxFilenameSamples: 2 }
    );

    expect(out.reports[0].counters?.evidence_filename_budget_exhausted).toBe(1);
    expect(out.reports[0].counters?.evidence_filename_budget).toBe(2);
    expect(out.reports[0].summary).toContain(
      '🔴 THE FILENAME SAMPLE BUDGET (2 rows) WAS EXHAUSTED after 10 of 12 members. ' +
        'Members are sampled newest-first, so the unsampled remainder is the OLDEST end of the ' +
        'window and scored 0 on filename clustering for want of data.'
    );
  });
});

/**
 * 🔴 THE LOG PAYLOAD THIS CHANGE NAMES AS THE THING THAT CLOSES THE LOOP — AND IT HAD NO COVERAGE
 * AT ALL. Neither `readFailures` nor `bot-account-detection:signals` appeared anywhere in this file
 * before these cases: deleting the `readFailures` key from the log call left the suite 362/362
 * green. The irony is the finding — this PR argues the `readFailures` COUNTERS have no consumer and
 * that the failure is closed by the log line and the report summary, and those were the two
 * surfaces with no guards on them while the counters were asserted in both directions on all four
 * keys.
 *
 * The scenario these must catch: any later edit to that payload returns the detector to its
 * pre-PR state — a failed source whose only record was a log line that no longer records it — with
 * CI green.
 */
describe('🔴 the signals log line carries the failure half, not just the availability half', () => {
  /** Captures `log(name, data)` so a payload is a value a test can assert on. */
  function logCapture() {
    const calls: Array<{ name: string; data: Record<string, unknown> }> = [];
    return {
      calls,
      log: (name: string, data: Record<string, unknown>) => {
        calls.push({ name, data });
      },
      /** The one `bot-account-detection:signals` payload, or a failure naming what WAS logged. */
      signals() {
        const hit = calls.filter((c) => c.name === 'bot-account-detection:signals');
        expect(
          hit,
          `expected exactly one bot-account-detection:signals log line, got names: ${calls
            .map((c) => c.name)
            .join(', ')}`
        ).toHaveLength(1);
        return hit[0].data;
      },
    };
  }

  const logRun = (evidence: Parameters<typeof runBotAccountDetection>[0]['evidence']) => {
    const { reader } = recordingReader([account(1), account(2)]);
    const out = sink();
    const cap = logCapture();
    return {
      ...cap,
      ...out,
      result: runBotAccountDetection(
        {
          reader,
          evidence,
          sendReport: out.sendReport,
          now: clock(),
          heuristics: [],
          log: cap.log,
        },
        { pageSize: 10, maxAccounts: 10, minConfidence: 0 }
      ),
    };
  };

  it('🔴 publishes readFailures with its real shape, one flag per source', async () => {
    // Only the IP read throws. The payload must say WHICH source broke — a boolean sum, or the key
    // omitted entirely, both read the same as the day nothing broke.
    const scenario = logRun({
      hasRegistrationIps: true,
      listRegistrationIps: async () => {
        throw new Error('clickhouse down');
      },
      listStagedImageSamples: async () => [],
      listFilenameSamples: async () => [],
    });
    await scenario.result;

    // `toEqual` on the whole object, not a property probe: it fails when the key is DELETED, when a
    // flag is dropped from the shape, and when the wrong source is blamed.
    expect(scenario.signals().readFailures).toEqual({
      registrationIps: true,
      filenameSamples: false,
      stagedImages: false,
    });
    // The availability half is still there beside it — the failure half is an addition, not a
    // replacement, and a reader needs both to tell a broken read from an absent client.
    expect(scenario.signals().registrationIps).toBe(false);
  });

  it('🔴 publishes it as all-false on a clean run — the control that makes a `true` mean something', async () => {
    // A field that appears only in the bad case cannot be alerted on, and a field only ever
    // observed in the bad case cannot be shown to be `false` for the right reason. Both reads
    // answer, both answer with nothing, and every flag must still be present and `false`.
    const scenario = logRun({
      hasRegistrationIps: true,
      listRegistrationIps: async () => [],
      listStagedImageSamples: async () => [],
      listFilenameSamples: async () => [],
    });
    await scenario.result;
    expect(scenario.signals().readFailures).toEqual({
      registrationIps: false,
      filenameSamples: false,
      stagedImages: false,
    });
  });

  it('🔴 a FAILED filename read and a QUIET one differ IN THE LOG LINE, not only in the counters', async () => {
    // The seam stated as a comparison rather than as a value, for the reason the counter version of
    // this case states: a production run's filename read failed on every attempt and its counters
    // were, number for number, the counters of a day on which nobody uploaded anything. The log
    // line is the surface this PR nominates as the fix, so the property has to hold THERE too.
    const failed = logRun({
      hasRegistrationIps: false,
      listRegistrationIps: async () => [],
      listStagedImageSamples: async () => [],
      listFilenameSamples: async () => {
        throw new Error('replica timeout');
      },
    });
    await failed.result;
    const quiet = logRun({
      hasRegistrationIps: false,
      listRegistrationIps: async () => [],
      listStagedImageSamples: async () => [],
      listFilenameSamples: async () => [],
    });
    await quiet.result;

    // Identical on the availability half — which is precisely why that half cannot carry the
    // distinction.
    expect(failed.signals().filenameSamples).toBe(false);
    expect(quiet.signals().filenameSamples).toBe(true);
    expect(failed.signals().readFailures).not.toEqual(quiet.signals().readFailures);
    expect(failed.signals().readFailures).toMatchObject({ filenameSamples: true });
    expect(quiet.signals().readFailures).toMatchObject({ filenameSamples: false });
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
    // The counter the content-templating false positive shows up in. A generic filename several
    // unrelated new accounts happen to upload under fires that heuristic and no other, so a run
    // inflated by collisions moves `heuristic:content-templating:sole_signal` and leaves `fired`
    // looking ordinary. Over the REPORTED members only: a sole signal below the threshold produced
    // no finding and cost nobody anything.
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

  it('🔴 counts a finding a TRACE from another heuristic used to EXCLUDE', async () => {
    // 🔴 THE COLLISION'S ROUTINE SHAPE, AND THE OLD PREDICATE COULD NOT SEE IT. `sole_signal` was
    // `exactly one heuristic scored above zero`, which measured a strictly smaller population than
    // the sentence it was documented with. The colliding member scores a TRACE on posting-velocity
    // as well — and that trace excluded the whole finding from the count. An operator reading
    // `content-templating:sole_signal = 0` concluded the known collision produced no reports, on
    // the one number the decision about that collision was deferred to.
    //
    // 🔴 THE FIXTURE THIS CASE USED TO CARRY IS RETRACTED — it was a member 40 minutes old with 6
    // parameter-paste COMMENTS under a bare `'paste'` fingerprint, and that member cannot exist:
    // comment text is no longer read, and what made two pastes collide was the deleted prose
    // normaliser's digit masking, which `normalizeFilename` deliberately does not apply. The
    // reachable collision is a generic FILENAME — an account that bulk-uploaded under one ordinary
    // name shared with other accounts registered the same day — so the fixture is one of those, with
    // a namespaced key, which is the only shape the index ever holds.
    //
    // The two scores below are EXECUTED against the shipped heuristics, not stipulated: if
    // `ZERO_AT_PER_HOUR` or `CLUSTER_ZERO_AT` moves, this case moves with it rather than pinning a
    // number the detector no longer produces.
    const colliding: BotAccountCohortMember = {
      userId: 1,
      username: 'u1',
      createdAt: new Date(STARTED.getTime() - 60 * 60_000),
      posts: {
        all: { comments: 0, models: 0, images: 8, total: 8 },
        visible: { comments: 0, models: 0, images: 8, total: 8 },
        excluded: { comments: 0, models: 0, images: 0, total: 0 },
      },
      emailDomain: null,
    };
    const signals = emptyCohortSignals();
    signals.fingerprintsByUser.set(1, ['file:logo.jpg']);
    signals.membersPerFingerprint.set('file:logo.jpg', 6);

    const velocity = postingVelocityHeuristic.score({ member: colliding, now: STARTED, signals });
    const templating = contentTemplatingHeuristic.score({
      member: colliding,
      now: STARTED,
      signals,
    });
    // 8 items in 1.0h is 8/hour, just over the 4/hour floor — a trace, not a finding.
    expect(velocity).toBeCloseTo(0.1111, 4);
    expect(templating).toBeCloseTo(0.5, 4);
    // The property that makes this the collision population rather than a corroborated finding. The
    // bar is a function of how many heuristics this RUN registered — four, injected below, matching
    // the shipped registry's size — and not of a number written down anywhere. That is the whole
    // point of `soleSignalDominance`: at FIVE entries the bar is 5 and this same member falls the
    // other side of it (5 x 0.1111 = 0.5556 against a leader of 0.5), which is the derivation
    // working rather than the case having stopped being a collision.
    expect(templating).toBeGreaterThanOrEqual(soleSignalDominance(4) * velocity);
    expect(templating).toBeLessThan(soleSignalDominance(5) * velocity);

    const { reader } = recordingReader([account(1)]);
    const out = sink();
    const result = await runBotAccountDetection(
      {
        reader,
        sendReport: out.sendReport,
        now: clock(),
        heuristics: [
          constantHeuristic(postingVelocityHeuristic.id, velocity),
          constantHeuristic(registrationClusterHeuristic.id, 0),
          constantHeuristic(contentTemplatingHeuristic.id, templating),
          constantHeuristic(assetStagingHeuristic.id, 0),
        ],
      },
      { pageSize: 10, maxAccounts: 10 }
    );

    // It cleared the threshold, so it is a report a moderator received — the count is over the
    // REPORTED members and this case has to be inside that population to mean anything.
    expect(result.findingsReported).toBe(1);
    // `fired` is what looks ordinary while the collision inflates the board: two heuristics fired.
    expect(result.counters[`heuristic:${postingVelocityHeuristic.id}:fired`]).toBe(1);
    expect(result.counters[`heuristic:${contentTemplatingHeuristic.id}:fired`]).toBe(1);

    expect(result.counters[`heuristic:${contentTemplatingHeuristic.id}:sole_signal`]).toBe(1);
    // The trace itself carried nothing, and must not be counted as though it had.
    expect(result.counters[`heuristic:${postingVelocityHeuristic.id}:sole_signal`]).toBe(0);
    expect(result.counters[`heuristic:${registrationClusterHeuristic.id}:sole_signal`]).toBe(0);
    expect(result.counters[`heuristic:${assetStagingHeuristic.id}:sole_signal`]).toBe(0);
  });

  it('🔴 is blind to REGISTRY ORDER, and counts nobody on a member nothing fired on', async () => {
    // Two mutants the case above cannot see, both of which inflate the counter in the reassuring
    // direction — the one direction this number must not fail in, since it is what a decision about
    // the content-templating collision is deferred to.
    //
    // 🔴 ORDER. `subScores` follows the registry order, and the registry is
    // [velocity, clustering, templating] — so the leading heuristic is routinely the LAST one seen,
    // and the account's real runner-up is a score that already held the lead. Failing to carry a
    // displaced leader into the runner-up leaves it at 0, and then EVERY finding looks sole.
    const { reader } = recordingReader([account(1)]);
    const out = sink();
    const ordered = await runBotAccountDetection(
      {
        reader,
        sendReport: out.sendReport,
        now: clock(),
        // Ascending, so the winner arrives last and 0.4 is only ever seen as a displaced leader.
        // 0.5 is not 3× 0.4, so neither heuristic carried this finding.
        heuristics: [constantHeuristic('low', 0.4), constantHeuristic('high', 0.5)],
      },
      { pageSize: 10, maxAccounts: 10 }
    );
    expect(ordered.findingsReported).toBe(1);
    expect(ordered.counters['heuristic:high:sole_signal']).toBe(0);
    expect(ordered.counters['heuristic:low:sole_signal']).toBe(0);

    // 🔴 NOTHING FIRED. `minConfidence: 0` reports a member every heuristic scored 0 on, and a
    // dominance test taken on its own is satisfied by 0 ≥ 3 × 0 — so without the score-above-zero
    // guard the first heuristic is credited with carrying a finding no heuristic saw anything for.
    const quiet = recordingReader([account(2)]);
    const out2 = sink();
    const silent = await runBotAccountDetection(
      {
        reader: quiet.reader,
        sendReport: out2.sendReport,
        now: clock(),
        heuristics: [constantHeuristic('a', 0), constantHeuristic('b', 0)],
      },
      { pageSize: 10, maxAccounts: 10, minConfidence: 0 }
    );
    expect(silent.findingsReported).toBe(1);
    expect(silent.counters['heuristic:a:sole_signal']).toBe(0);
    expect(silent.counters['heuristic:b:sole_signal']).toBe(0);
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

describe('🔴 the cluster key reaches the board', () => {
  /**
   * Six accounts registered on ONE uncommon email domain, run end to end through the PRODUCTION
   * heuristic registry.
   *
   * Six, not four: `DOMAIN_ZERO_AT` is 3, so six overshoots the boundary rather than sitting on it —
   * a fixture landing exactly ON a boundary cannot see a mutant that shifts it by one.
   */
  const RING_DOMAIN = 'ring-provider.test';
  const ringAccounts = (domain: string, n = 6) =>
    Array.from({ length: n }, (_, i) => ({ ...account(i + 1), email: `u${i + 1}@${domain}` }));

  /**
   * 🔴 AN EVIDENCE READER IS REQUIRED EVEN THOUGH IT RETURNS NOTHING, and finding that out is itself
   * the point: `membersPerDomain` is built by `collectCohortSignals`, which `run.ts` only calls when
   * `deps.evidence` is present. Without one the domain index is EMPTY, so a real six-account ring
   * scores 0 and carries no key — the same reason the sibling block above needs a control arm. This
   * reader answers both remote sources with nothing, so the IP and content halves stay at 0 and
   * anything the findings carry came from the domain half alone.
   */
  const domainOnlyEvidence = {
    hasRegistrationIps: false,
    listRegistrationIps: async () => [],
    listStagedImageSamples: async () => [],
    listFilenameSamples: async () => [],
  };

  const domainRun = (accounts: NewAccountRow[]) => {
    const { reader } = recordingReader(accounts);
    const out = sink();
    return {
      ...out,
      result: runBotAccountDetection(
        { reader, evidence: domainOnlyEvidence, sendReport: out.sendReport, now: clock() },
        { pageSize: 10, maxAccounts: 10, minConfidence: 0 }
      ),
    };
  };

  it('every member of the ring is emitted with the SAME key', async () => {
    // 🔴 THE SEAM `run.ts` OWNS, and the mutant it exists for: handing `buildFinding` an empty
    // signals index, or forgetting the argument entirely, leaves every finding ungrouped while
    // `heuristics.test.ts` and `report.test.ts` both stay green — each covers one side and neither
    // ever builds the combined state. Every ring on the board would then be ruled one account at a
    // time, with nothing anywhere reporting a fault.
    const scenario = domainRun(ringAccounts(RING_DOMAIN));
    await scenario.result;

    const findings = scenario.reports[0].findings;
    expect(findings).toHaveLength(6);
    // The LITERAL key, not a re-derivation: an assertion computed from the code under test cannot
    // see the prefix change or the wrong attribute being used.
    expect(findings.map((f) => f.groupKey)).toEqual(Array(6).fill('domain:ring-provider.test'));
  });

  it('🔴 the key names only what the reason already says — checked on the emitted finding', () => {
    // The disclosure rule, asserted where it matters: on the payload that reaches the board.
    const scenario = domainRun(ringAccounts(RING_DOMAIN));
    return scenario.result.then(() => {
      for (const f of scenario.reports[0].findings) {
        expect(f.groupKey).toBe('domain:ring-provider.test');
        expect(f.reason).toContain(RING_DOMAIN);
      }
    });
  });

  it('a cohort with DISTINCT domains is emitted ungrouped — the control', async () => {
    // Without this the case above attributes nothing: findings carrying a key prove the wiring only
    // if findings carry none when there is no ring, and "always sets a key" is a real mutant.
    const scenario = domainRun(Array.from({ length: 6 }, (_, i) => account(i + 1)));
    await scenario.result;

    const findings = scenario.reports[0].findings;
    expect(findings).toHaveLength(6);
    expect(findings.every((f) => f.groupKey === undefined)).toBe(true);
  });

  it('a ring on a COMMON provider is emitted ungrouped', async () => {
    // `gmail.com` is the largest cluster in every cohort, every day. A key there would collapse the
    // day's most ordinary accounts into one ruling.
    const scenario = domainRun(ringAccounts('gmail.com'));
    await scenario.result;
    expect(scenario.reports[0].findings.every((f) => f.groupKey === undefined)).toBe(true);
  });

  it('the payloads still satisfy the real wire contract', async () => {
    const scenario = domainRun(ringAccounts(RING_DOMAIN));
    await scenario.result;
    for (const report of scenario.reports)
      expect(() => abuseReportInput.parse(report)).not.toThrow();
  });

  /**
   * 🔴 A PATHOLOGICAL DOMAIN MUST NOT BE ABLE TO STOP THE DETECTOR.
   *
   * `normalizeEmailDomain` bounds the domain at nothing, so `domain:${domain}` was producer-supplied
   * and unbounded against a contract that caps `groupKey` at 200 characters. Over the cap the report
   * is REFUSED — and because this run validates before the network call, the throw takes the run
   * down, losing that batch and every batch after it. Four accounts on one uncommon domain is all
   * that is needed, and a wildcard-MX subdomain chain under an attacker-owned apex fits inside DNS's
   * own 253-character limit: a denial-of-detection lever, not an edge case.
   */
  const ABSURD_DOMAIN = `${'a'.repeat(236)}.test`;

  it('🔴 a ring on an absurdly long domain still produces a report the contract accepts', async () => {
    expect(ABSURD_DOMAIN).toHaveLength(241);
    const scenario = domainRun(ringAccounts(ABSURD_DOMAIN));
    await scenario.result;

    expect(scenario.reports).toHaveLength(1);
    for (const report of scenario.reports)
      expect(() => abuseReportInput.parse(report)).not.toThrow();
  });

  it('and every member of THAT ring still shares one key', async () => {
    // Bounding is only useful if it keeps the grouping: a per-member key would give a forty-account
    // ring forty separate decisions, which is the state this feature exists to remove.
    const scenario = domainRun(ringAccounts(ABSURD_DOMAIN));
    await scenario.result;

    const keys = scenario.reports[0].findings.map((f) => f.groupKey);
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size, 'the ring must still be ONE cluster').toBe(1);
    // Inside the contract's cap, and not the raw key.
    expect((keys[0] as string).length).toBeLessThanOrEqual(200);
    expect(keys[0]).not.toBe(`domain:${ABSURD_DOMAIN}`);
  });

  it('a SECOND absurd domain gets a different key — the clusters do not merge', async () => {
    // Truncation would give both the same 200-character string, and a moderator ruling one ring
    // would rule the other. Two domains sharing a long prefix, which is the shape a subdomain chain
    // under one apex actually has.
    const other = `${'a'.repeat(230)}zzzzzz.test`;
    expect(other).toHaveLength(241);
    const a = domainRun(ringAccounts(ABSURD_DOMAIN));
    await a.result;
    const b = domainRun(ringAccounts(other));
    await b.result;
    expect(a.reports[0].findings[0].groupKey).not.toBe(b.reports[0].findings[0].groupKey);
  });
});
