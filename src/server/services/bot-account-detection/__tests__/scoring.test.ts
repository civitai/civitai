import { describe, expect, it } from 'vitest';
import type { BotAccountCohortMember, SurfaceCounts } from '../cohort';
import { emptyCohortSignals } from '../evidence';
import { BOT_ACCOUNT_HEURISTICS } from '../heuristics';
import {
  CONFIDENCE_BUCKETS,
  MIN_REPORTED_CONFIDENCE,
  confidenceBucket,
  confidenceBucketCounters,
  confidenceBucketKey,
  heuristicCounters,
  partitionByConfidence,
  placeholderHeuristic,
  renderNotes,
  renderSubScores,
  scoreAccount,
  type BotAccountEvidence,
  type BotAccountHeuristic,
  type BotAccountScore,
} from '../scoring';

const NOW = new Date('2026-09-03T12:00:00.000Z');

const surface = (partial: Partial<SurfaceCounts> = {}): SurfaceCounts => {
  const row = { comments: 0, models: 0, images: 0, ...partial };
  return { ...row, total: row.comments + row.models + row.images };
};

/**
 * 🔴 THIS FIXTURE WAS THE WRONG SHAPE and nothing caught it. It read
 * `posts: { comments: 1, models: 0, images: 2, total: 3 }` — the FLAT `SurfaceCounts` that
 * `PostCounts` stopped being when membership moved onto unfiltered counts. `src/**\/__tests__/**` is
 * excluded from `tsconfig.json`, so no typecheck ever looked at it, and every assertion in this file
 * happened to be about blending rather than about `posts`, so nothing read the bad field either. A
 * fixture that cannot occur in production is a test asserting against a world that does not exist;
 * corrected here because this change gives `posts` a consumer (`heuristics/velocity.ts`).
 */
const member: BotAccountCohortMember = {
  userId: 12,
  username: 'candidate',
  createdAt: new Date('2026-09-03T09:00:00.000Z'),
  posts: {
    all: surface({ comments: 1, images: 2 }),
    visible: surface({ comments: 1, images: 2 }),
    excluded: surface(),
  },
  emailDomain: 'example.test',
};
const evidence: BotAccountEvidence = { member, now: NOW, signals: emptyCohortSignals() };

const heuristic = (
  id: string,
  value: number,
  weight = 1,
  note: string | null = null
): BotAccountHeuristic => ({
  id,
  description: `test heuristic ${id}`,
  weight,
  score: () => value,
  explain: () => note,
});

describe('the shipped registry', () => {
  it('🔴 carries the three real heuristics and NOT the placeholder', () => {
    // The placeholder shipped as the sole registered heuristic and was labelled "delete it in the
    // change that adds the first real heuristic". This asserts the deletion happened — an asserted
    // ledger of ids, so it fails if the registry grows (the LLM read is a separate change and must
    // not arrive unnoticed) as well as if it shrinks.
    expect(BOT_ACCOUNT_HEURISTICS.map((h) => h.id)).toEqual([
      'posting-velocity',
      'registration-cluster',
      'content-templating',
    ]);
    expect(BOT_ACCOUNT_HEURISTICS.map((h) => h.id)).not.toContain('placeholder-no-op');
  });

  it('weights them equally, so the blend is a plain mean of three opinions', () => {
    // Load-bearing for the threshold's reasoning: `MIN_REPORTED_CONFIDENCE` is derived from
    // "one of three equally-weighted heuristics at 0.45". A re-weighting that left the threshold
    // alone would silently change what the threshold admits, and this is what makes that a
    // deliberate edit with a failing test attached.
    expect([...new Set(BOT_ACCOUNT_HEURISTICS.map((h) => h.weight))]).toEqual([1]);
  });

  it('every registered heuristic describes itself for the humans reading a report', () => {
    for (const h of BOT_ACCOUNT_HEURISTICS) {
      expect(h.description.length, `${h.id} has no description`).toBeGreaterThan(40);
      // The id is a metric key and a counters namespace — a colon in it would read ambiguously
      // against the `heuristic:<id>:fired` keys it becomes.
      expect(h.id, `${h.id} is not an identifier`).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('the placeholder is still inert, and is kept only for these tests', () => {
    expect(placeholderHeuristic.score(evidence)).toBe(0);
    expect(placeholderHeuristic.explain(evidence, 0)).toBeNull();
    expect(scoreAccount([placeholderHeuristic], evidence).confidence).toBe(0);
  });
});

describe('scoreAccount', () => {
  it('reports each heuristic separately, not only the blend', () => {
    // The whole reason the seam exists: a signal that fires on everything is useless whatever the
    // blend does with it, and that is only visible if its own number survives to the report.
    const result = scoreAccount([heuristic('a', 0.2), heuristic('b', 0.9)], evidence);
    expect(result.subScores.map((s) => ({ id: s.id, score: s.score }))).toEqual([
      { id: 'a', score: 0.2 },
      { id: 'b', score: 0.9 },
    ]);
  });

  it('blends by weight, not by count', () => {
    // 0.2*1 + 0.6*4 = 2.6 over a total weight of 5 → 0.52. Deliberately not the unweighted mean
    // (0.4) and not either input, so a mutant that ignores the weights, sums instead of averaging,
    // or returns one member's score cannot land on it.
    const result = scoreAccount([heuristic('a', 0.2, 1), heuristic('b', 0.6, 4)], evidence);
    expect(result.confidence).toBeCloseTo(0.52, 10);
  });

  it('returns 0 rather than NaN for an empty registry', () => {
    const result = scoreAccount([], evidence);
    expect(result.confidence).toBe(0);
    expect(result.subScores).toEqual([]);
  });

  it.each([
    ['above 1', 4.2, 1],
    ['below 0', -3, 0],
    // 🔴 Both non-finite values go to 0, not to the nearest bound. `Infinity` is a DEFECT in the
    // heuristic, not a maximal opinion about the account, and clamping it to 1 would put a
    // top-confidence finding in front of a moderator on the strength of a divide-by-zero.
    ['NaN', Number.NaN, 0],
    ['Infinity', Number.POSITIVE_INFINITY, 0],
  ])('clamps a %s sub-score and records that it did', (_label, raw, expected) => {
    // 🔴 An unclamped value 400s the whole REPORT against `confidence: z.number().max(1)`, losing
    // every finding in the batch rather than the offending one. Clamping is the only safe
    // direction; `clamped` is what stops it being silent.
    const result = scoreAccount([heuristic('rogue', raw)], evidence);
    expect(result.subScores[0].score).toBe(expected);
    expect(result.subScores[0].clamped).toBe(true);
    expect(result.confidence).toBe(expected);
  });

  it('does not flag an in-range score as clamped', () => {
    expect(scoreAccount([heuristic('ok', 0.3)], evidence).subScores[0].clamped).toBe(false);
  });

  it('hands the heuristic the run clock rather than letting it read one', () => {
    let seen: BotAccountEvidence | undefined;
    scoreAccount([{ ...heuristic('spy', 0), score: (e) => ((seen = e), 0) }], evidence);
    expect(seen?.now).toBe(NOW);
    expect(seen?.member).toBe(member);
  });

  it('keeps a heuristic’s note beside its own score', () => {
    const result = scoreAccount([heuristic('a', 0.5, 1, 'because reasons')], evidence);
    expect(result.subScores[0].note).toBe('because reasons');
  });
});

describe('heuristicCounters', () => {
  it('counts evaluations, firings and clamps per heuristic', () => {
    // Three distinct numbers, because "how often does this fire, and how hard" cannot be answered
    // by a single count: a signal that never triggers and one that triggers weakly on everything
    // are the two failures shadow mode exists to tell apart.
    const scores = [
      scoreAccount([heuristic('a', 0.4), heuristic('b', 0)], evidence),
      scoreAccount([heuristic('a', 0), heuristic('b', 0)], evidence),
      scoreAccount([heuristic('a', 9), heuristic('b', 0)], evidence),
    ];
    expect(heuristicCounters(scores)).toEqual({
      'heuristic:a:evaluated': 3,
      'heuristic:a:fired': 2,
      'heuristic:a:clamped': 1,
      'heuristic:b:evaluated': 3,
      'heuristic:b:fired': 0,
      'heuristic:b:clamped': 0,
    });
  });

  it('publishes a zero rather than omitting a heuristic that never fired', () => {
    // A counter that appears only in the interesting case cannot be alerted on: its absence is
    // indistinguishable from the producer not having run.
    const counters = heuristicCounters([scoreAccount([heuristic('quiet', 0)], evidence)]);
    expect(counters['heuristic:quiet:fired']).toBe(0);
  });

  it('is empty for a run with no accounts', () => {
    expect(heuristicCounters([])).toEqual({});
  });
});

describe('renderNotes', () => {
  it('names the heuristic beside its own clause', () => {
    // 🔴 The notes were collected into `HeuristicScore.note` and then never rendered — the reason
    // string carried `id=0.00` and no statement of what anything SAW. Invisible while the only
    // heuristic was a placeholder whose note was always null.
    expect(
      renderNotes([
        { id: 'a', score: 0.5, weight: 1, note: 'saw three things', clamped: false },
        { id: 'b', score: 0.2, weight: 1, note: 'saw a fourth', clamped: false },
      ])
    ).toBe('a: saw three things | b: saw a fourth');
  });

  it('omits a heuristic that said nothing, rather than rendering an empty clause', () => {
    expect(
      renderNotes([
        { id: 'a', score: 0.5, weight: 1, note: 'saw three things', clamped: false },
        { id: 'quiet', score: 0, weight: 1, note: null, clamped: false },
      ])
    ).toBe('a: saw three things');
  });

  it('returns null when nothing fired, so the caller can drop the clause entirely', () => {
    expect(renderNotes([{ id: 'a', score: 0, weight: 1, note: null, clamped: false }])).toBeNull();
    expect(renderNotes([])).toBeNull();
  });
});

const scored = (userId: number, confidence: number): BotAccountScore => ({
  userId,
  confidence,
  subScores: [],
});

describe('the reporting threshold', () => {
  it('🔴 defaults to a value derived from the blend arithmetic, not an intuition', () => {
    // With three equal weights the blend is their mean, so 0.15 admits ONE heuristic at ~0.45 and
    // rejects an account where every signal is weak. Pinned because the number is the whole
    // difference between a usable board and a board nobody reads on its second day.
    expect(MIN_REPORTED_CONFIDENCE).toBe(0.15);
    // One heuristic fully convinced blends to 1/3 — comfortably reported.
    expect(1 / BOT_ACCOUNT_HEURISTICS.length).toBeGreaterThan(MIN_REPORTED_CONFIDENCE);
    // One heuristic at 0.4 blends to 0.133 — below the cut. So the threshold genuinely bites
    // somewhere a single moderate signal lives, rather than being decorative.
    expect(0.4 / BOT_ACCOUNT_HEURISTICS.length).toBeLessThan(MIN_REPORTED_CONFIDENCE);
  });

  it('reports a score EXACTLY at the threshold', () => {
    // `>=`, or the constant's own name is a lie — a "minimum reported confidence" that is not
    // itself reported. The off-by-one would be invisible in the counters.
    const { reported, suppressed } = partitionByConfidence([scored(1, 0.15)], 0.15);
    expect(reported.map((s) => s.userId)).toEqual([1]);
    expect(suppressed).toEqual([]);
  });

  it('suppresses below and reports above, and returns BOTH halves', () => {
    // Values deliberately overshoot the boundary in both directions rather than sitting on it —
    // 0.02 and 0.9 against a 0.15 cut — so a mutant flipping the comparison, or moving the cut by
    // a step, cannot land on this expectation.
    const { reported, suppressed } = partitionByConfidence(
      [scored(1, 0.02), scored(2, 0.9), scored(3, 0.14), scored(4, 0.31)],
      0.15
    );
    expect(reported.map((s) => s.userId)).toEqual([2, 4]);
    // 🔴 The suppressed half comes back rather than being dropped: the caller needs to COUNT it.
    // A member nobody can see is a member nobody can grade.
    expect(suppressed.map((s) => s.userId)).toEqual([1, 3]);
  });

  it('a threshold of 0 reports everything — the deliberate full-cohort grading run', () => {
    const { reported, suppressed } = partitionByConfidence([scored(1, 0), scored(2, 0.5)], 0);
    expect(reported).toHaveLength(2);
    expect(suppressed).toHaveLength(0);
  });
});

describe('the confidence distribution', () => {
  it('buckets by tenths, half-open', () => {
    expect(confidenceBucket(0)).toBe(0);
    expect(confidenceBucket(0.099)).toBe(0);
    expect(confidenceBucket(0.1)).toBe(1);
    expect(confidenceBucket(0.55)).toBe(5);
    expect(confidenceBucket(0.9)).toBe(9);
  });

  it('🔴 puts 1.0 in the TOP bucket rather than inventing an eleventh', () => {
    // A naive `floor(c * 10)` gives 10 for a perfect score — a bucket with no key, so the most
    // interesting accounts in the run vanish from the distribution and the buckets stop summing to
    // the number scored. That is a silent loss of exactly the rows a grading pass wants.
    expect(confidenceBucket(1)).toBe(CONFIDENCE_BUCKETS - 1);
    expect(confidenceBucketKey(confidenceBucket(1))).toBe('confidence_bucket_90_100');
  });

  it('names each bucket in percent, so the key is an identifier', () => {
    expect(confidenceBucketKey(0)).toBe('confidence_bucket_0_10');
    expect(confidenceBucketKey(9)).toBe('confidence_bucket_90_100');
    // The wire contract caps a counter key at 64 characters.
    for (let i = 0; i < CONFIDENCE_BUCKETS; i += 1)
      expect(confidenceBucketKey(i).length).toBeLessThanOrEqual(64);
  });

  it('🔴 counts EVERY scored member, suppressed ones included', () => {
    // The whole point of the distribution: it is the counterweight that makes the threshold safe.
    // Four of these five are below the default cut and would appear nowhere else in the report.
    const counters = confidenceBucketCounters([
      scored(1, 0),
      scored(2, 0.02),
      scored(3, 0.05),
      scored(4, 0.07),
      scored(5, 0.94),
    ]);
    expect(counters['confidence_bucket_0_10']).toBe(4);
    expect(counters['confidence_bucket_90_100']).toBe(1);
    // Every bucket sums back to the population — nothing was dropped on the way in.
    const total = Object.values(counters).reduce((a, b) => a + b, 0);
    expect(total).toBe(5);
  });

  it('publishes every bucket including the empty ones, on a run with no accounts', () => {
    // A counter that appears only when non-zero cannot be charted or alerted on: its absence is
    // indistinguishable from the producer not having run.
    const counters = confidenceBucketCounters([]);
    expect(Object.keys(counters)).toHaveLength(CONFIDENCE_BUCKETS);
    expect(Object.values(counters).every((v) => v === 0)).toBe(true);
  });

  it('does not lose a non-finite score out of the distribution', () => {
    // `scoreAccount` clamps, so these should be unreachable — which is exactly why they are pinned:
    // an unreachable value that silently vanishes is how a bucket total stops matching the cohort.
    //
    // 🔴 `Infinity` GOES TO THE BOTTOM BUCKET, NOT THE TOP, and that is the same rule `clampScore`
    // states one layer up: a non-finite score is a DEFECT in a heuristic — a divide by zero, an
    // empty denominator — not a maximal opinion about the account. Bucketing it high would put a
    // top-confidence-looking row in the distribution on the strength of a bug, in the one direction
    // a shadow-mode detector must not fail in. Written the other way round first; the code was
    // right and the expectation was wrong.
    expect(confidenceBucket(Number.NaN)).toBe(0);
    expect(confidenceBucket(Number.POSITIVE_INFINITY)).toBe(0);
    expect(confidenceBucket(-1)).toBe(0);
    // A finite over-1 value still clamps UP, because that is an in-range opinion expressed badly
    // rather than a defect — the same asymmetry `clampScore` draws.
    expect(confidenceBucket(4.2)).toBe(CONFIDENCE_BUCKETS - 1);
  });
});

describe('renderSubScores', () => {
  it('names every heuristic and its own number', () => {
    expect(
      renderSubScores([
        { id: 'a', score: 0.125, weight: 1, note: null, clamped: false },
        { id: 'b', score: 1, weight: 1, note: null, clamped: false },
      ])
    ).toBe('a=0.13, b=1.00');
  });

  it('says so when nothing is registered, rather than rendering an empty clause', () => {
    expect(renderSubScores([])).toBe('no heuristics registered');
  });
});
