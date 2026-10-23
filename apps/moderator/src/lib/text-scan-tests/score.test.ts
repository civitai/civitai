import { describe, expect, it } from 'vitest';
import {
  countCases,
  flipOf,
  orderFlippedFirst,
  passRates,
  scoreCase,
  summarise,
  verdictOf,
  type CaseScore,
  type StoredResult,
} from './score';

const ok = (output: unknown): StoredResult => ({ status: 'ok', output });
const rated = (level: string) => ok({ nsfw: { level, reason: 'synthetic' } });
const flagged = (label: string, detected: boolean) => ok({ [label]: { detected } });

describe('verdictOf', () => {
  it('passes an unsegmented output through', () => {
    expect(verdictOf({ nsfw: { level: 'r' } })).toEqual({
      verdict: { nsfw: { level: 'r' } },
      segments: null,
    });
  });

  it('reads the merged verdict of a segmented output and counts its segments', () => {
    const output = { merged: { scam: { detected: true } }, segments: [{}, {}, {}] };
    expect(verdictOf(output)).toEqual({ verdict: { scam: { detected: true } }, segments: 3 });
  });

  it('returns no verdict for a non-object', () => {
    expect(verdictOf(null)).toEqual({ verdict: null, segments: null });
  });
});

describe('scoreCase — nsfw ranges', () => {
  const range = { nsfw: { min: 'pg13', max: 'r' } } as const;

  it('passes inside the range, at both ends', () => {
    expect(scoreCase(range, rated('pg13'))).toMatchObject({ state: 'scored', pass: true });
    expect(scoreCase(range, rated('r'))).toMatchObject({ state: 'scored', pass: true });
  });

  it('a range of one passes only on that level', () => {
    const one = { nsfw: { min: 'x', max: 'x' } } as const;
    expect(scoreCase(one, rated('x'))).toMatchObject({ pass: true });
    expect(scoreCase(one, rated('xxx'))).toMatchObject({
      pass: false,
      labels: [{ label: 'nsfw', predicted: 'xxx', offBy: 1 }],
    });
  });

  it('records how far below or above the range a miss landed', () => {
    expect(scoreCase(range, rated('none'))).toMatchObject({ labels: [{ offBy: -1 }] });
    expect(scoreCase(range, rated('xxx'))).toMatchObject({ labels: [{ offBy: 2 }] });
  });

  it('fails an unreadable rating without an offset', () => {
    expect(scoreCase(range, ok({ nsfw: { level: 'weird' } }))).toMatchObject({
      pass: false,
      labels: [{ label: 'nsfw', predicted: null, offBy: null }],
    });
  });
});

describe('scoreCase — flags and any labels', () => {
  it('passes when the flag matches, and needs every scored label to pass', () => {
    expect(scoreCase({ scam: true }, flagged('scam', true))).toMatchObject({ pass: true });
    expect(
      scoreCase(
        { poi: false, minor: true },
        ok({ poi: { detected: false }, minor: { detected: false } })
      )
    ).toMatchObject({ pass: false });
  });

  it('scores only the labels the expectation names', () => {
    expect(
      scoreCase({ poi: true }, ok({ poi: { detected: true }, minor: { detected: true } }))
    ).toEqual({
      state: 'scored',
      pass: true,
      labels: [{ label: 'poi', pass: true, predicted: true }],
    });
  });

  it('never scores an error, a skip, a missing result or an empty expectation', () => {
    expect(scoreCase({ scam: true }, { status: 'error', output: null })).toEqual({
      state: 'error',
    });
    expect(scoreCase({ scam: true }, { status: 'skipped', output: null })).toEqual({
      state: 'skipped',
    });
    expect(scoreCase({ scam: true }, undefined)).toEqual({ state: 'missing' });
    expect(scoreCase({}, flagged('scam', true))).toEqual({ state: 'unscored' });
  });

  it('never scores an ok result whose verdict was wiped with its text', () => {
    expect(scoreCase({ scam: true }, ok(null))).toEqual({ state: 'missing' });
  });
});

describe('summarise', () => {
  it('counts nsfw passes, misses below and above, and off-by-one', () => {
    const range = { nsfw: { min: 'pg13', max: 'pg13' } } as const;
    const scores = ['pg13', 'none', 'r', 'xxx'].map((l) => scoreCase(range, rated(l)));
    expect(summarise(scores)).toEqual([
      { label: 'nsfw', scored: 4, passed: 1, under: 1, over: 2, offByOne: 2, unanswered: 0 },
    ]);
  });

  it('counts flag caught, missed and false flags', () => {
    const scores = [
      scoreCase({ scam: true }, flagged('scam', true)),
      scoreCase({ scam: true }, flagged('scam', false)),
      scoreCase({ scam: false }, flagged('scam', true)),
      scoreCase({ scam: false }, flagged('scam', false)),
      scoreCase({ scam: true }, { status: 'error', output: null }),
    ];
    expect(summarise(scores)).toEqual([
      { label: 'scam', scored: 4, passed: 2, caught: 1, missed: 1, falseFlags: 1, unanswered: 0 },
    ]);
  });

  it('gives pass rates per label, null with nothing scored', () => {
    const scores = [
      scoreCase({ scam: true }, flagged('scam', true)),
      scoreCase({ scam: true }, flagged('scam', false)),
    ];
    expect(passRates(summarise(scores))).toEqual({ scam: 0.5 });
    expect(passRates([])).toEqual({});
  });

  it('counts cases by state', () => {
    const scores: CaseScore[] = [
      { state: 'scored', pass: true, labels: [] },
      { state: 'scored', pass: false, labels: [] },
      { state: 'error' },
      { state: 'skipped' },
      { state: 'missing' },
      { state: 'unscored' },
    ];
    expect(countCases(scores)).toEqual({
      scored: 2,
      passed: 1,
      error: 1,
      skipped: 1,
      missing: 1,
      unscored: 1,
    });
  });
});

describe('flips', () => {
  const pass: CaseScore = { state: 'scored', pass: true, labels: [] };
  const fail: CaseScore = { state: 'scored', pass: false, labels: [] };
  const error: CaseScore = { state: 'error' };

  it('names each transition', () => {
    expect(flipOf(pass, fail)).toBe('regressed');
    expect(flipOf(fail, pass)).toBe('fixed');
    expect(flipOf(fail, fail)).toBe('still-failing');
    expect(flipOf(pass, pass)).toBe('still-passing');
    expect(flipOf(error, pass)).toBe('not-compared');
    expect(flipOf(pass, error)).toBe('not-compared');
  });

  it('reads a single run by its own pass or fail', () => {
    expect(flipOf(null, fail)).toBe('still-failing');
    expect(flipOf(null, pass)).toBe('still-passing');
  });

  it('lists regressions first, then fixes, then the rest, by case id within a group', () => {
    const rows = [
      { caseId: 1, flip: 'still-passing' as const },
      { caseId: 2, flip: 'fixed' as const },
      { caseId: 3, flip: 'regressed' as const },
      { caseId: 4, flip: 'not-compared' as const },
      { caseId: 5, flip: 'still-failing' as const },
      { caseId: 0, flip: 'regressed' as const },
    ];
    expect(orderFlippedFirst(rows).map((r) => r.caseId)).toEqual([0, 3, 2, 5, 4, 1]);
  });
});
