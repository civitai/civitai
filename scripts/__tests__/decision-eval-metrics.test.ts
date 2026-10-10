import { describe, expect, it } from 'vitest';

import {
  classAtThreshold,
  cohensKappa,
  expectedCalibrationError,
  fitClassThreshold,
  wilsonInterval,
  wilsonLower,
  type Scored,
} from '../decision-eval/metrics';
import { sliceRow } from '../decision-eval/report';
import { countCorrect, fitThresholds, scoreSplit } from '../decision-eval/scorer';
import type { ManifestItem, Prediction } from '../decision-eval/types';

describe('wilsonInterval', () => {
  it('matches the published 95% interval for 81/100', () => {
    const ci = wilsonInterval(81, 100);
    expect(ci?.lower).toBeCloseTo(0.7222, 4);
    expect(ci?.upper).toBeCloseTo(0.8749, 4);
  });

  it('a perfect 18/18 has a lower bound of only ~0.824', () => {
    expect(wilsonLower(18, 18)).toBeCloseTo(0.8241, 4);
  });

  it('is null, not 0, with nothing to measure', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});

describe('cohensKappa', () => {
  it('computes (po - pe) / (1 - pe)', () => {
    // po = 0.7; both raters 50/50, so pe = 0.5 and kappa = 0.4.
    const pairs: Array<[string, string]> = [
      ...Array(35).fill(['a', 'a']),
      ...Array(35).fill(['b', 'b']),
      ...Array(15).fill(['a', 'b']),
      ...Array(15).fill(['b', 'a']),
    ];
    expect(cohensKappa(pairs)).toBeCloseTo(0.4, 10);
  });

  it('is null over no pairs', () => {
    expect(cohensKappa([])).toBeNull();
  });
});

describe('expectedCalibrationError', () => {
  it('is |confidence - accuracy| weighted by bin size', () => {
    const items: Scored[] = [
      { pred: 'a', gold: 'a', confidence: 0.95 },
      { pred: 'a', gold: 'b', confidence: 0.95 },
    ];
    expect(expectedCalibrationError(items)).toBeCloseTo(0.45, 10);
  });

  it('ignores items with no confidence, and is null when none have one', () => {
    expect(expectedCalibrationError([{ pred: 'a', gold: 'a', confidence: null }])).toBeNull();
  });
});

describe('fitClassThreshold', () => {
  const confident = (n: number, conf: number, correct: boolean): Scored[] =>
    Array.from({ length: n }, () => ({ pred: 'x', gold: correct ? 'x' : 'y', confidence: conf }));

  it('reports insufficient-n when even a perfect record could not clear the target', () => {
    const fit = fitClassThreshold(confident(18, 0.99, true), 'x', 0.9);
    expect(fit).toEqual({
      status: 'insufficient-n',
      available: 18,
      bestPossibleLower: expect.any(Number),
    });
  });

  it('picks the LOWEST threshold whose Wilson lower bound clears the target', () => {
    // 60 right at 0.9; 20 wrong at 0.5. At t=0 precision is 0.75; at t=0.9 it is 60/60.
    const items = [...confident(60, 0.9, true), ...confident(20, 0.5, false)];
    const fit = fitClassThreshold(items, 'x', 0.9);
    expect(fit.status).toBe('fitted');
    if (fit.status !== 'fitted') return;
    expect(fit.threshold).toBe(0.9);
    expect(fit.atThreshold.covered).toBe(60);
  });

  it('reports no-threshold when there is enough data but precision never clears', () => {
    const items = [...confident(60, 0.9, true), ...confident(40, 0.9, false)];
    expect(fitClassThreshold(items, 'x', 0.9)).toEqual({ status: 'no-threshold', available: 100 });
  });

  it('🔴 the sorted sweep finds the same threshold as checking every candidate', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    let fitted = 0;
    for (let trial = 0; trial < 50; trial++) {
      const items: Scored[] = Array.from({ length: 200 }, () => {
        const confidence = rand() < 0.05 ? null : Math.round(rand() * 20) / 20;
        const correct = rand() < 0.5 + 0.5 * (confidence ?? 0);
        return { pred: 'x', gold: correct ? 'x' : 'y', confidence };
      });
      const target = 0.6 + rand() * 0.3;
      const candidates = [0, ...new Set(items.map((i) => i.confidence ?? 0))].sort((a, b) => a - b);
      const brute = candidates
        .map((t) => classAtThreshold(items, 'x', t))
        .find((at) => at.wilsonLower !== null && at.wilsonLower >= target);
      const fit = fitClassThreshold(items, 'x', target);
      if (brute) {
        fitted++;
        expect(fit).toEqual({ status: 'fitted', threshold: brute.threshold, atThreshold: brute });
      } else {
        expect(fit.status).not.toBe('fitted');
      }
    }
    // Both branches must be exercised, or the comparison proves little.
    expect(fitted).toBeGreaterThan(10);
    expect(fitted).toBeLessThan(50);
  });

  it('never covers a null-confidence item above threshold 0', () => {
    const at = classAtThreshold([{ pred: 'x', gold: 'x', confidence: null }], 'x', 0.5);
    expect(at.covered).toBe(0);
  });
});

describe('report rows', () => {
  it('🔴 puts missing, refused and errors in their own columns', () => {
    const row = sliceRow('model', {
      total: 10,
      missing: 1,
      refused: 2,
      errors: 3,
      unlabelled: 0,
      answered: 4,
      abstained: 0,
      abstentionRate: 0,
      correct: 4,
      accuracy: 1,
      kappa: null,
      ece: null,
    });
    expect(row).toBe('| model | 10 | 1 | 2 | 3 | 4 | 0.0% | 100.0% | n/a | n/a |');
  });
});

describe('scorer', () => {
  const item = (itemId: string, split: ManifestItem['split'] = 'dev'): ManifestItem => ({
    itemId,
    groupKey: `g-${itemId}`,
    ts: '2026-09-20T00:00:00Z',
    split,
    state: {},
    slices: { lang: itemId === 'c' ? 'de' : 'en' },
  });
  const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => item(id));
  const gold = new Map([
    ['a', 'x'],
    ['b', 'y'],
    ['c', 'x'],
    ['d', 'x'],
    ['e', 'y'],
    ['f', 'x'],
  ]);
  const predictions: Prediction[] = [
    { itemId: 'a', runKey: 'k', status: 'ok', pred: 'x', confidence: 0.9, abstained: false },
    { itemId: 'b', runKey: 'k', status: 'ok', pred: 'x', confidence: 0.6, abstained: false },
    { itemId: 'c', runKey: 'k', status: 'ok', pred: null, confidence: null, abstained: true },
    { itemId: 'd', runKey: 'k', status: 'missing' },
    { itemId: 'e', runKey: 'k', status: 'error', error: 'ImajevError: imajev returned HTTP 500' },
    {
      itemId: 'f',
      runKey: 'k',
      status: 'refused',
      error: 'state.text contains a url-shaped string',
    },
  ];
  const input = { items, gold, predictions, classes: ['x', 'y'] };

  it('🔴 keeps missing images and failed calls out of every denominator', () => {
    const s = scoreSplit(input, 'dev');
    expect(s).toMatchObject({
      total: 6,
      missing: 1,
      refused: 1,
      errors: 1,
      answered: 2,
      abstained: 1,
      correct: 1,
      accuracy: 0.5,
    });
    expect(s.abstentionRate).toBeCloseTo(1 / 3, 10);
  });

  it('applies per-class thresholds to precision and coverage', () => {
    const s = scoreSplit(input, 'dev', { x: 0.8 });
    expect(s.perClass.x).toMatchObject({ covered: 1, correct: 1, precision: 1 });
    expect(s.coverage).toBeCloseTo(1 / 3, 10);
  });

  it('🔴 counts only classes that have a threshold towards coverage', () => {
    // b is predicted x; with no threshold for x nothing may act, so nothing is covered.
    expect(scoreSplit(input, 'dev', { y: 0.5 }).coverage).toBe(0);
  });

  it('reports abstention per gold label', () => {
    expect(scoreSplit(input, 'dev').abstentionByGold).toEqual({
      x: { n: 2, abstained: 1, rate: 0.5 },
      y: { n: 1, abstained: 0, rate: 0 },
    });
  });

  it('slices by the item slice keys', () => {
    const s = scoreSplit(input, 'dev');
    expect(s.slices.lang.de).toMatchObject({ total: 1, abstained: 1, answered: 0 });
    expect(s.slices.lang.en).toMatchObject({ total: 5, answered: 2, refused: 1 });
  });

  it('counts correct answers against whatever gold it is handed', () => {
    expect(countCorrect(input, gold)).toBe(1);
    expect(countCorrect(input, new Map([...gold, ['b', 'x']]))).toBe(2);
  });

  it('fits thresholds on dev items only', () => {
    const testOnly = { ...input, items: items.map((i) => ({ ...i, split: 'test' as const })) };
    expect(fitThresholds(testOnly, { x: 0.5, y: 0.5 }).x).toEqual({
      status: 'insufficient-n',
      available: 0,
      bestPossibleLower: null,
    });
  });
});
