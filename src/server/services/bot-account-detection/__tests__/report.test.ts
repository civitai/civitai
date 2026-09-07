import { MAX_FINDINGS_PER_REPORT, abuseReportInput } from '@civitai/moderation';
import { describe, expect, it } from 'vitest';
import type { BotAccountCohortMember, PostCounts, SurfaceCounts } from '../cohort';
import {
  BOT_ACCOUNT_DETECTOR,
  buildFinding,
  buildReports,
  chunkFindings,
  renderPostCounts,
  truncateReason,
} from '../report';
import type { BotAccountScore } from '../scoring';

const at = (iso: string) => new Date(iso);
const STARTED = at('2026-09-03T03:20:00.000Z');
const FINISHED = at('2026-09-03T03:20:41.000Z');

const surface = (partial: Partial<SurfaceCounts> = {}): SurfaceCounts => {
  const row = { comments: 0, models: 0, images: 0, ...partial };
  return { ...row, total: row.comments + row.models + row.images };
};

/** `visible` defaults to everything posted — nothing taken down, the ordinary case. */
const posts = (
  all: Partial<SurfaceCounts>,
  visiblePartial: Partial<SurfaceCounts> = all
): PostCounts => {
  const a = surface(all);
  const v = surface(visiblePartial);
  return {
    all: a,
    visible: v,
    excluded: {
      comments: Math.max(0, a.comments - v.comments),
      models: Math.max(0, a.models - v.models),
      images: Math.max(0, a.images - v.images),
      total: Math.max(0, a.total - v.total),
    },
  };
};

const member = (overrides: Partial<BotAccountCohortMember> = {}): BotAccountCohortMember => ({
  userId: 91,
  username: 'newcomer',
  createdAt: at('2026-09-03T00:20:00.000Z'),
  posts: posts({ comments: 2, models: 1, images: 3 }),
  emailDomain: 'newcomer.test',
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

  it('🔴 carries each heuristic’s NOTE, not only its number', () => {
    // 🔴 THE GAP THIS CLOSES. `HeuristicScore.note` was collected on every score and rendered
    // nowhere: the reason carried `Per-heuristic: a=0.60` and no statement of what the heuristic
    // SAW, which is the half a moderator needs to decide anything. It was invisible while the only
    // registered heuristic was a placeholder whose note was always null.
    const finding = buildFinding(
      member(),
      score({
        confidence: 0.42,
        subScores: [
          {
            id: 'registration-cluster',
            score: 0.6,
            weight: 1,
            note: '9 new posting accounts share its registration IP',
            clamped: false,
          },
          { id: 'content-templating', score: 0, weight: 1, note: null, clamped: false },
        ],
      }),
      STARTED
    );
    expect(finding.reason).toContain(
      'Signals — registration-cluster: 9 new posting accounts share its registration IP.'
    );
    // The heuristic that said nothing contributes no clause — a reason reciting every signal that
    // did not fire buries the one that did.
    expect(finding.reason).not.toContain('content-templating:');
    // The numbers still follow, for both.
    expect(finding.reason).toContain('registration-cluster=0.60, content-templating=0.00');
  });

  it('omits the signals clause entirely when nothing fired', () => {
    // Rather than rendering `Signals — .`, which reads as a truncation.
    expect(buildFinding(member(), score(), STARTED).reason).not.toContain('Signals —');
  });

  it('cites the evidence a moderator needs to judge it', () => {
    const finding = buildFinding(member(), score(), STARTED);
    // Distinct counts per surface so a mutant reading the wrong field cannot produce this string.
    expect(finding.reason).toContain('Posted 6 item(s) — 2 comment(s), 1 model(s), 3 image(s).');
    expect(finding.reason).toContain('3.0h old');
    expect(finding.reason).toContain('placeholder-no-op=0.00');
    expect(finding.reason).toContain('NOT actioned');
  });

  it('🔴 pins the WHOLE clause when nothing was taken down — carve-out included', () => {
    // 🔴 THE WIRE CONTRACT CALLS THIS STRING "the whole value of the row to a moderator", so it is
    // pinned as a whole normalised string rather than by keyword. A guard on words is walkable by
    // rewording; this one makes a cosmetic reword a deliberate edit with a failing test attached.
    //
    // 🔴 The Pending carve-out is part of the pin, in THIS branch too. It was absent here while the
    // excluded branch carried it, and this is the branch a young account with three unscanned
    // uploads takes — see `renderPostCounts`.
    expect(renderPostCounts(posts({ comments: 2, models: 1, images: 3 }))).toBe(
      'Posted 6 item(s) — 2 comment(s), 1 model(s), 3 image(s). All 6 still on the site ' +
        '(nothing hidden, blocked, unpublished or removed). ' +
        'Images still awaiting a scan result are counted as on the site.'
    );
  });

  it('🔴 leads with what was POSTED and states the split, when content was taken down', () => {
    // 🔴 THE F-2 REGRESSION, in the sentence a moderator reads. Forty uploads, thirty-nine blocked:
    // the finding used to say "1 visible image(s)", so a queue sorted by volume put the worst
    // account last. The total leads; the split follows and says plainly what is gone and why.
    //
    // Pairwise-distinct numbers across all three lines — 40/1/39, and comments 5/2/3 — so no
    // mutant that reads `visible` for `all`, or recomputes `excluded` the other way round, can
    // land on this string.
    expect(
      renderPostCounts(posts({ comments: 5, models: 0, images: 40 }, { comments: 2, images: 1 }))
    ).toBe(
      'Posted 45 item(s) — 5 comment(s), 0 model(s), 40 image(s). ' +
        'Still on the site: 3 (2 comment(s), 0 model(s), 1 image(s)). ' +
        'NOT on the site: 42 (3 comment(s), 0 model(s), 39 image(s)) — drafts, unpublished or ' +
        'scheduled models, unattached uploads, uploads the scanner blocked or could not find, and ' +
        'hidden, TOS-flagged or already-removed content. Images still awaiting a scan result are ' +
        'counted as on the site.'
    );
  });

  it('🔴 an account with NOTHING left on the site still leads with what it posted', () => {
    // The canonical bot wave: 40 images, every one blocked. Under the old rule this account was not
    // in the cohort at all, so there was no finding for this sentence to be wrong in.
    const finding = buildFinding(member({ posts: posts({ images: 40 }, {}) }), score(), STARTED);
    expect(finding.reason).toContain('Posted 40 item(s) — 0 comment(s), 0 model(s), 40 image(s).');
    expect(finding.reason).toContain('Still on the site: 0 (0 comment(s), 0 model(s), 0 image(s))');
    expect(finding.reason).toContain('NOT on the site: 40 (0 comment(s), 0 model(s), 40 image(s))');
  });

  it('🔴 never calls the reported number "visible" — the Pending carve-out', () => {
    // 🔴 `cohort.ts` deliberately counts an image whose scan has not finished as on-site, and that
    // is exactly the case a moderator cannot view. "N visible image(s)" claimed something the query
    // does not deliver. The replacement states the carve-out in the same sentence, so this checks
    // BOTH halves: the over-claiming word is gone, and the caveat that replaced it is present.
    const shown = renderPostCounts(posts({ images: 40 }, { images: 1 }));
    expect(shown).not.toContain('visible');
    expect(shown).toContain('Images still awaiting a scan result are counted as on the site.');
    // 🔴 AND THE NO-EXCLUSIONS BRANCH, which is where this actually bites. Three uploads, all
    // attached, all `ingestion: Pending` — `excluded.total` is 0, so nothing has been taken down and
    // there is nothing for a moderator to look at either. Dropping the word "visible" was never
    // enough on its own here: "All 3 still on the site" makes the same claim in other words.
    const allPending = renderPostCounts(posts({ images: 3 }));
    expect(allPending).not.toContain('visible');
    expect(allPending).toContain('Images still awaiting a scan result are counted as on the site.');
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
