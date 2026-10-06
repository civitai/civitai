import { describe, expect, it } from 'vitest';
import { caseCorrect, diffRuns, percent, scoreChips, totals } from './score';
import type { Expected } from './types';

const nsfw = (level: string) => ({ nsfw: { level, reason: 'r' } });
const flag = (label: string, detected: boolean) => ({ [label]: { detected, reason: 'r' } });

describe('caseCorrect', () => {
  const range: Expected = { nsfw: { min: 'pg13', max: 'r' } };

  it('accepts both ends of the nsfw range and nothing outside it', () => {
    expect(caseCorrect(range, nsfw('pg13'))).toEqual({ nsfw: true });
    expect(caseCorrect(range, nsfw('r'))).toEqual({ nsfw: true });
    expect(caseCorrect(range, nsfw('none'))).toEqual({ nsfw: false });
    expect(caseCorrect(range, nsfw('x'))).toEqual({ nsfw: false });
  });

  it('scores a flag by its detected verdict', () => {
    expect(caseCorrect({ poi: true }, flag('poi', true))).toEqual({ poi: true });
    expect(caseCorrect({ scam: false }, flag('scam', true))).toEqual({ scam: false });
  });

  it('does not score a label the case leaves unscored', () => {
    expect(caseCorrect({ poi: true }, { ...nsfw('xxx'), ...flag('poi', true) })).toEqual({
      poi: true,
    });
  });

  it('does not score a label the output lacks', () => {
    expect(
      caseCorrect({ nsfw: { min: 'r', max: 'r' }, minor: false }, flag('minor', false))
    ).toEqual({ minor: true });
  });
});

describe('totals', () => {
  const ok = (expected: Expected, output: Record<string, unknown>) => ({
    expected,
    output,
    status: 'ok',
  });

  it('counts the binary R-or-higher for nsfw', () => {
    const t = totals([
      ok({ nsfw: { min: 'r', max: 'x' } }, nsfw('x')), // tp, correct
      ok({ nsfw: { min: 'r', max: 'x' } }, nsfw('pg13')), // fn, wrong
      ok({ nsfw: { min: 'none', max: 'pg13' } }, nsfw('r')), // fp, wrong
      ok({ nsfw: { min: 'none', max: 'pg13' } }, nsfw('none')), // tn, correct
    ]);
    expect(t.nsfw).toEqual({
      scored: 4,
      correct: 2,
      tp: 1,
      fp: 1,
      fn: 1,
      tn: 1,
      precision: 0.5,
      recall: 0.5,
    });
  });

  it('keeps a range crossing R out of tp/fp/fn/tn but scores it', () => {
    const t = totals([
      ok({ nsfw: { min: 'pg13', max: 'r' } }, nsfw('r')), // correct, no class
      ok({ nsfw: { min: 'none', max: 'x' } }, nsfw('pg13')), // correct, no class
      ok({ nsfw: { min: 'pg13', max: 'r' } }, nsfw('xxx')), // wrong, no class
      ok({ nsfw: { min: 'r', max: 'x' } }, nsfw('x')), // tp
    ]);
    expect(t.nsfw).toEqual({
      scored: 4,
      correct: 3,
      tp: 1,
      fp: 0,
      fn: 0,
      tn: 0,
      precision: 1,
      recall: 1,
    });
  });

  it('counts flag labels against detected', () => {
    const t = totals([
      ok({ scam: true }, flag('scam', true)),
      ok({ scam: true }, flag('scam', true)),
      ok({ scam: false }, flag('scam', true)),
      ok({ scam: true }, flag('scam', false)),
    ]);
    expect(t.scam).toMatchObject({ scored: 4, correct: 2, tp: 2, fp: 1, fn: 1, tn: 0 });
    expect(t.scam.precision).toBeCloseTo(2 / 3);
    expect(t.scam.recall).toBeCloseTo(2 / 3);
  });

  it('leaves precision null when nothing was predicted positive, recall null when nothing is', () => {
    const t = totals([ok({ poi: false }, flag('poi', false))]);
    expect(t.poi).toMatchObject({ scored: 1, correct: 1, tn: 1, precision: null, recall: null });
  });

  it('counts only ok rows, and no label a case leaves unscored', () => {
    const t = totals([
      ok({ poi: true }, { ...nsfw('xxx'), ...flag('poi', true) }),
      { expected: { poi: true }, output: { error: 'boom' }, status: 'error' },
      { expected: { poi: true }, output: null, status: 'skipped' },
    ]);
    expect(t).toEqual({
      poi: {
        scored: 1,
        correct: 1,
        tp: 1,
        fp: 0,
        fn: 0,
        tn: 0,
        precision: 1,
        recall: 1,
      },
    });
  });
});

describe('diffRuns', () => {
  it('lists only labels that flipped between two runs', () => {
    const a = new Map<number, Record<string, boolean>>([
      [1, { nsfw: true, poi: true }],
      [2, { nsfw: false }],
      [3, { scam: true }],
      [4, { nsfw: true }],
    ]);
    const b = new Map<number, Record<string, boolean>>([
      [1, { nsfw: false, poi: true }],
      [2, { nsfw: true }],
      [3, { scam: true }],
      // Case 4 is missing from b and case 5 from a: neither is a flip.
      [5, { nsfw: false }],
    ]);
    expect(diffRuns(a, b)).toEqual({
      newlyWrong: [{ caseId: 1, label: 'nsfw' }],
      newlyRight: [{ caseId: 2, label: 'nsfw' }],
    });
  });

  it('ignores a label scored on only one side', () => {
    expect(diffRuns(new Map([[1, { nsfw: true }]]), new Map([[1, { poi: false }]]))).toEqual({
      newlyWrong: [],
      newlyRight: [],
    });
  });
});

describe('scoreChips and percent', () => {
  it('summarises each scored label and renders an undefined ratio as a dash', () => {
    const t = totals([
      { expected: { scam: true }, output: flag('scam', false), status: 'ok' },
      { expected: { scam: false }, output: flag('scam', false), status: 'ok' },
    ]);
    expect(scoreChips(t)).toEqual(['scam 1/2']);
    expect(scoreChips(null)).toEqual([]);
    expect(percent(t.scam.precision)).toBe('—');
    expect(percent(2 / 3)).toBe('67%');
  });
});
