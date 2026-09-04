import { MAX_FINDINGS_PER_REPORT, abuseReportInput } from '@civitai/moderation';
import { describe, expect, it } from 'vitest';
import type { BotAccountCohortMember } from '../cohort';
import {
  BOT_ACCOUNT_DETECTOR,
  buildFinding,
  buildReports,
  chunkFindings,
  truncateReason,
} from '../report';
import type { BotAccountScore } from '../scoring';

const at = (iso: string) => new Date(iso);
const STARTED = at('2026-09-03T03:20:00.000Z');
const FINISHED = at('2026-09-03T03:20:41.000Z');

const member = (overrides: Partial<BotAccountCohortMember> = {}): BotAccountCohortMember => ({
  userId: 91,
  username: 'newcomer',
  createdAt: at('2026-09-03T00:20:00.000Z'),
  posts: { comments: 2, models: 1, images: 3, total: 6 },
  ...overrides,
});

const score = (overrides: Partial<BotAccountScore> = {}): BotAccountScore => ({
  userId: 91,
  confidence: 0.25,
  subScores: [{ id: 'placeholder-no-op', score: 0, weight: 1, note: null, clamped: false }],
  ...overrides,
});

const findings = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    buildFinding(member({ userId: i + 1 }), score({ userId: i + 1 }), STARTED)
  );

const build = (n: number, maxFindingsPerReport?: number) =>
  buildReports({
    findings: findings(n),
    startedAt: STARTED,
    finishedAt: FINISHED,
    counters: { cohort_size: n },
    summary: 'Scanned things.',
    maxFindingsPerReport,
  });

describe('buildFinding', () => {
  it('is never actioned, and carries no action name', () => {
    const finding = buildFinding(member(), score(), STARTED);
    expect(finding.actioned).toBe(false);
    // `action` ABSENT, not null: the contract refuses an action name beside `actioned: false`, and
    // omitting the key makes the wrong pair unrepresentable rather than merely unset today.
    expect(finding).not.toHaveProperty('action');
  });

  it('passes the blended confidence through unaltered', () => {
    expect(buildFinding(member(), score({ confidence: 0.75 }), STARTED).confidence).toBe(0.75);
  });

  it('cites the evidence a moderator needs to judge it', () => {
    const finding = buildFinding(member(), score(), STARTED);
    // Distinct counts per surface so a mutant reading the wrong field cannot produce this string.
    expect(finding.reason).toContain('2 comment(s)');
    expect(finding.reason).toContain('1 model(s)');
    expect(finding.reason).toContain('3 image(s)');
    expect(finding.reason).toContain('3.0h old');
    expect(finding.reason).toContain('placeholder-no-op=0.00');
    expect(finding.reason).toContain('NOT actioned');
  });

  it('floors the account age at zero when the clocks disagree', () => {
    const future = member({ createdAt: at('2026-09-03T05:00:00.000Z') });
    expect(buildFinding(future, score(), STARTED).reason).toContain('0.0h old');
  });

  it('survives an account with no username', () => {
    const finding = buildFinding(member({ username: null }), score(), STARTED);
    expect(finding.reason).toContain('Account 91 registered');
    expect(finding.reason.length).toBeGreaterThan(0);
  });
});

describe('truncateReason', () => {
  it('leaves a reason inside the limit alone', () => {
    expect(truncateReason('short', 10)).toBe('short');
  });

  it('cuts an over-long reason to the limit and marks the cut', () => {
    const cut = truncateReason('x'.repeat(50), 10);
    expect(cut).toHaveLength(10);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('keeps a generated reason within the contract’s own bound', () => {
    const finding = buildFinding(
      member({ username: 'n'.repeat(4_000) }),
      score({
        subScores: Array.from({ length: 200 }, (_, i) => ({
          id: `heuristic-${i}`,
          score: 0.5,
          weight: 1,
          note: null,
          clamped: false,
        })),
      }),
      STARTED
    );
    expect(finding.reason.length).toBeLessThanOrEqual(2_000);
    expect(() =>
      abuseReportInput.parse({
        detector: BOT_ACCOUNT_DETECTOR,
        startedAt: STARTED.toISOString(),
        finishedAt: FINISHED.toISOString(),
        findings: [finding],
      })
    ).not.toThrow();
  });
});

describe('chunkFindings', () => {
  it('returns one empty batch for an empty run', () => {
    // A run that found nothing must still reach the board: "no report today" and "a report with
    // zero findings" look identical to a reader otherwise, and the first is what a broken
    // producer looks like.
    expect(chunkFindings([], 10)).toEqual([[]]);
  });

  it('splits at the size boundary with a short final batch', () => {
    // 7 into 3 — deliberately not a multiple, and not a power-of-two multiple of the size, so the
    // remainder branch actually runs.
    expect(chunkFindings([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it('refuses a size that could never terminate', () => {
    expect(() => chunkFindings([1], 0)).toThrow(/chunk size/);
  });
});

describe('buildReports', () => {
  it('files one report for a run under the cap', () => {
    const reports = build(3, 10);
    expect(reports).toHaveLength(1);
    expect(reports[0].detector).toBe(BOT_ACCOUNT_DETECTOR);
    expect(reports[0].findings).toHaveLength(3);
  });

  it('batches at the real MAX_FINDINGS_PER_REPORT', () => {
    // 2,501 OVERSHOOTS the 1,000 cap by an amount that is neither a multiple of it nor a power of
    // two times it, so the full-batch branch, the remainder branch and the multi-batch numbering all
    // execute. A fixture of exactly 1,000 or 2,000 exercises none of them.
    const reports = build(2_501);
    expect(MAX_FINDINGS_PER_REPORT).toBe(1_000);
    expect(reports.map((r) => r.findings.length)).toEqual([1_000, 1_000, 501]);
    expect(reports.every((r) => r.findings.length <= MAX_FINDINGS_PER_REPORT)).toBe(true);
  });

  it('gives every batch a DISTINCT startedAt', () => {
    // 🔴 `(detector, started_at)` is the receiving table's idempotency key: re-reporting the pair
    // REPLACES the run and deletes its previous findings. Two batches sharing a startedAt would
    // therefore show the last 501 findings of a 2,501-finding run with nothing to indicate the
    // other 2,000 ever arrived.
    const reports = build(2_501);
    const startedAt = reports.map((r) => r.startedAt);
    expect(new Set(startedAt).size).toBe(reports.length);
    // Ascending, so a board sorting by started_at renders the batches in order.
    expect([...startedAt].sort()).toEqual(startedAt);
  });

  it('keeps finishedAt at or after each batch’s own startedAt', () => {
    // A run fast enough to finish inside `batchCount` milliseconds would otherwise emit
    // `finishedAt < startedAt` on a later batch, which the contract refuses outright — losing a
    // whole report to the run having been quick.
    const reports = buildReports({
      findings: findings(2_501),
      startedAt: STARTED,
      finishedAt: STARTED,
      counters: {},
      summary: 'Instant run.',
    });
    for (const report of reports)
      expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
  });

  it('makes the batching observable in counters and summary', () => {
    const reports = build(2_501);
    expect(reports.map((r) => r.counters?.batch_index)).toEqual([1, 2, 3]);
    expect(reports.every((r) => r.counters?.batch_count === 3)).toBe(true);
    expect(reports.map((r) => r.counters?.batch_findings)).toEqual([1_000, 1_000, 501]);
    expect(reports.every((r) => r.counters?.run_findings === 2_501)).toBe(true);
    expect(reports[1].summary).toContain('Batch 2 of 3');
  });

  it('carries the run counters into every batch', () => {
    const reports = build(2_501);
    expect(reports.every((r) => r.counters?.cohort_size === 2_501)).toBe(true);
  });

  it('says in every summary that nothing was acted on', () => {
    for (const report of build(2_501)) expect(report.summary).toContain('SHADOW MODE');
  });

  it('marks every finding of every batch un-actioned', () => {
    for (const report of build(2_501))
      for (const finding of report.findings) expect(finding.actioned).toBe(false);
  });

  it('produces payloads the real wire contract accepts', () => {
    // The REAL schema, imported rather than a fixture shape that can drift from it. This is what
    // stops the producer discovering a CHECK violation on the receiving side, where it aborts the
    // transaction and loses the whole run.
    for (const report of build(2_501)) expect(() => abuseReportInput.parse(report)).not.toThrow();
  });

  it('still files a report when the run found nothing', () => {
    const reports = build(0);
    expect(reports).toHaveLength(1);
    expect(reports[0].findings).toEqual([]);
    expect(() => abuseReportInput.parse(reports[0])).not.toThrow();
  });
});
