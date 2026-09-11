import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_FINDINGS_PER_REPORT, abuseReportInput } from '@civitai/moderation';
import { describe, expect, it } from 'vitest';
import type { BotAccountCohortMember, PostCounts, SurfaceCounts } from '../cohort';
import {
  BOT_ACCOUNT_DETECTOR,
  HASHED_GROUP_KEY_PREFIX,
  boundGroupKey,
  buildFinding,
  buildReports,
  chunkFindings,
  renderPostCounts,
  truncateReason,
} from '../report';
import type { BotAccountScore } from '../scoring';

/** This directory, so the doc-claim guard below can read the module it is asserting about. */
const HERE = dirname(fileURLToPath(import.meta.url));

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

describe('buildFinding — the cluster key', () => {
  it('carries the key it was given', () => {
    const finding = buildFinding(member(), score(), STARTED, 'domain:ring.test');
    expect(finding.groupKey).toBe('domain:ring.test');
  });

  it('OMITS the key entirely when there is no cluster', () => {
    // Absent, not null — the same choice `action` makes above. An ungrouped finding must not be
    // representable as "in a cluster called nothing", and the three detectors that never group are
    // meant to look exactly like this.
    const finding = buildFinding(member(), score(), STARTED);
    expect(finding).not.toHaveProperty('groupKey');
  });

  it('omits it for an explicit null too', () => {
    expect(buildFinding(member(), score(), STARTED, null)).not.toHaveProperty('groupKey');
  });

  it('🔴 defaults to ungrouped, so an existing caller is unchanged by the new parameter', () => {
    // Two other detectors post to this board through the same contract. A required fourth argument —
    // or a default of anything but "no cluster" — would silently group their findings.
    const before = buildFinding(member(), score(), STARTED);
    const explicit = buildFinding(member(), score(), STARTED, null);
    expect(before).toEqual(explicit);
  });

  it('produces a payload the real wire contract accepts, key and all', () => {
    const report = buildReports({
      findings: [buildFinding(member(), score(), STARTED, 'domain:ring.test')],
      startedAt: STARTED,
      finishedAt: FINISHED,
      counters: {},
      summary: 'Scanned things.',
    })[0];
    // 🔴 READ OFF THE PARSED PAYLOAD, NOT THE BUILT ONE. Asserting the key on the object this file
    // constructed proves only that this file constructed it; the contract is what the receiving app
    // actually gets, and a zod object STRIPS a key it does not declare. Deleting `groupKey` from
    // `packages/civitai-moderation/src/schema.ts` left the whole detector suite green while the
    // board received nothing — the key was dropped in transit, silently.
    const parsed = abuseReportInput.parse(report);
    expect(parsed.findings[0].groupKey).toBe('domain:ring.test');
  });

  it('changes nothing else about the finding', () => {
    // A key must not perturb the fields a moderator reads, and above all not `actioned`.
    const grouped = buildFinding(member(), score(), STARTED, 'domain:ring.test');
    const lone = buildFinding(member(), score(), STARTED);
    expect(grouped.actioned).toBe(false);
    expect(grouped.reason).toBe(lone.reason);
    expect(grouped.confidence).toBe(lone.confidence);
    expect(grouped.userId).toBe(lone.userId);
  });
});

/**
 * 🔴 AN UNBOUNDED CLUSTER KEY CAN ABORT A WHOLE DETECTOR RUN.
 *
 * `groupKey` is capped at 200 characters by the wire contract, and `normalizeEmailDomain` caps the
 * domain at nothing — so `domain:${domain}` is producer-supplied and unbounded. Over the cap it does
 * not lose the one finding: `abuseReportInput.safeParse` fails `too_big`, `run.ts` validates BEFORE
 * the network call, and the throw aborts the run — losing that batch and every batch after it.
 * Exactly the failure `truncateReason` exists to prevent for the OTHER producer-supplied string on
 * this contract, in a second one that shipped without the same treatment.
 *
 * 🔴 AND IT IS HASHED, NOT TRUNCATED, because a key is an IDENTITY rather than prose. Two distinct
 * domains sharing a long prefix would truncate to ONE key and merge two unrelated clusters into a
 * single ruling — a moderator would rule a ring they never looked at, with one click.
 */
describe('boundGroupKey — the cluster key stays inside the wire contract', () => {
  /** The measured boundary: 193 characters parse, 194 do not, once `domain:` is prepended. */
  const CONTRACT_CAP = 200;
  const longDomain = (n: number) => `${'a'.repeat(n - 4)}.com`;

  const parses = (groupKey: string) =>
    abuseReportInput.safeParse({
      detector: 'bot-account-detection',
      startedAt: '2026-09-03T03:20:00.000Z',
      finishedAt: '2026-09-03T03:20:41.000Z',
      findings: [{ userId: 1, confidence: 0.5, reason: 'r', actioned: false, groupKey }],
    }).success;

  it('negative control — the RAW key is what the contract refuses', () => {
    // The hazard, demonstrated on the unbounded value, so the guard below is not asserted against a
    // cap that was never reachable. 240 + `domain:` = 247 characters.
    const raw = `domain:${longDomain(240)}`;
    expect(raw).toHaveLength(247);
    expect(parses(raw)).toBe(false);
    // …and one character under the cap still parses, so the refusal is the LENGTH and not the shape.
    expect(parses(`domain:${'b'.repeat(CONTRACT_CAP - 7)}`)).toBe(true);
  });

  it('leaves an ordinary key exactly as it was', () => {
    // The overwhelmingly common case must not be perturbed: the key is rendered on the board, and a
    // hash where a domain could have been shown is a worse row for no reason.
    expect(boundGroupKey('domain:ring.test')).toBe('domain:ring.test');
    expect(boundGroupKey('domain:' + 'b'.repeat(CONTRACT_CAP - 7))).toHaveLength(CONTRACT_CAP);
  });

  it('brings an over-long key inside the cap, and the contract then accepts it', () => {
    const bounded = boundGroupKey(`domain:${longDomain(240)}`);
    expect(bounded.length).toBeLessThanOrEqual(CONTRACT_CAP);
    expect(bounded.startsWith(HASHED_GROUP_KEY_PREFIX)).toBe(true);
    expect(parses(bounded)).toBe(true);
  });

  it('🔴 two members of ONE cluster still share a key — grouping survives the bound', () => {
    // The property the whole feature rests on. A key that differed per member would give a ring of
    // forty findings forty separate decisions, which is the state this feature exists to remove.
    const domain = longDomain(240);
    expect(boundGroupKey(`domain:${domain}`)).toBe(boundGroupKey(`domain:${domain}`));
  });

  it('🔴 two DIFFERENT clusters do not collide — which truncation would not give', () => {
    // Same 193-character prefix, different domains. `slice(0, 199)` returns the identical string for
    // both; the digest does not. This is the case that makes hashing the right instrument.
    const shared = 'a'.repeat(193);
    const a = `domain:${shared}alpha.com`;
    const b = `domain:${shared}beta.com`;
    expect(a.slice(0, 199)).toBe(b.slice(0, 199));
    expect(boundGroupKey(a)).not.toBe(boundGroupKey(b));
    // Both still inside the cap, so "they differ" is not achieved by leaving one unbounded.
    for (const k of [boundGroupKey(a), boundGroupKey(b)])
      expect(k.length).toBeLessThanOrEqual(CONTRACT_CAP);
  });

  it('a hashed key cannot be confused with a domain key', () => {
    // Its own prefix, so the two namespaces cannot overlap however the digest comes out.
    expect(boundGroupKey(`domain:${longDomain(240)}`).startsWith('domain:')).toBe(false);
  });

  it('🔴 the figure `report.ts` reports as MEASURED is the one this file measures', () => {
    // The comment on `boundGroupKey` said a 240-character domain yields a **251**-character key. The
    // prefix is 7 characters, so it is 247 — which is what the negative control above asserts, and
    // the two sibling figures in the same sentence (193 / 194) are right, which is exactly what made
    // the wrong one read as measured. A number a reader is told was measured has to have been.
    //
    // 🔴 THE WHOLE SENTENCE IS PINNED, not the digits. A guard on "247" alone is walkable by a
    // reword that moves the claim somewhere else; this fails on any edit to it, which is the price
    // of a machine-checkable claim about prose.
    // Block-comment continuation markers stripped before collapsing whitespace, or a sentence that
    // wraps across lines carries a `*` into the middle of itself and no assertion can match it.
    const source = readFileSync(join(HERE, '../report.ts'), 'utf8')
      .split('\n')
      .map((line) => line.replace(/^\s*\*\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');
    // Derived here, from the contract's own prefix and the case the sentence describes — never read
    // back out of the source it is checking.
    const measured = `domain:${longDomain(240)}`.length;
    expect(measured).toBe(247);
    expect(source).toContain(
      `Measured: a 240-char email domain yields a ${measured}-character key and the whole report ` +
        'is refused (boundary: 193 characters parses, 194 fails).'
    );
  });
});

describe('buildFinding bounds the key it is handed', () => {
  it('🔴 a 240-character domain no longer refuses the whole report', () => {
    // The end-to-end regression: the run builds a finding for a real cluster, and the report it goes
    // into must be one the receiving contract accepts. Before the bound, `parse` threw here and
    // `run.ts` — which validates before the network call — aborted the run and every batch after it.
    const key = `domain:${'a'.repeat(236)}.com`;
    expect(key).toHaveLength(247);
    const report = buildReports({
      findings: [buildFinding(member(), score(), STARTED, key)],
      startedAt: STARTED,
      finishedAt: FINISHED,
      counters: {},
      summary: 'Scanned things.',
    })[0];

    // 🔴 Read off the PARSED payload, for the reason the sibling case above documents: a zod object
    // strips what it does not declare, so asserting on the built object proves only what this file
    // constructed.
    const parsed = abuseReportInput.parse(report);
    expect(parsed.findings[0].groupKey).toBe(boundGroupKey(key));
    expect((parsed.findings[0].groupKey as string).length).toBeLessThanOrEqual(200);
  });

  it('every member of one over-long cluster is emitted with the SAME key', () => {
    const key = `domain:${'a'.repeat(236)}.com`;
    const one = buildFinding(member({ userId: 1 }), score(), STARTED, key);
    const two = buildFinding(member({ userId: 2 }), score(), STARTED, key);
    expect(one.groupKey).toBe(two.groupKey);
    expect(one.groupKey).not.toBe(key);
  });
});
