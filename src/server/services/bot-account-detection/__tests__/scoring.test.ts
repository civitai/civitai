import { describe, expect, it } from 'vitest';
import type { BotAccountCohortMember } from '../cohort';
import {
  BOT_ACCOUNT_HEURISTICS,
  heuristicCounters,
  placeholderHeuristic,
  renderSubScores,
  scoreAccount,
  type BotAccountEvidence,
  type BotAccountHeuristic,
} from '../scoring';

const NOW = new Date('2026-09-03T12:00:00.000Z');

const member: BotAccountCohortMember = {
  userId: 12,
  username: 'candidate',
  createdAt: new Date('2026-09-03T09:00:00.000Z'),
  posts: { comments: 1, models: 0, images: 2, total: 3 },
};
const evidence: BotAccountEvidence = { member, now: NOW };

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
  it('carries only the labelled placeholder — no detection ships in this change', () => {
    expect(BOT_ACCOUNT_HEURISTICS.map((h) => h.id)).toEqual(['placeholder-no-op']);
    expect(placeholderHeuristic.description).toMatch(/[Pp]laceholder/);
  });

  it('scores every account 0, so nothing here is a calibration', () => {
    expect(placeholderHeuristic.score(evidence)).toBe(0);
    expect(placeholderHeuristic.explain(evidence, 0)).toBeNull();
    expect(scoreAccount(BOT_ACCOUNT_HEURISTICS, evidence).confidence).toBe(0);
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
