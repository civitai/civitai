import { describe, expect, it } from 'vitest';
import { planRun, poolFor, scoreRun, seededShuffle } from './plan';

const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

describe('planRun', () => {
  const base = {
    core: ids(100, 6),
    freshUnseen: ids(200, 20),
    length: 10,
    freshCount: 7,
  };

  it('is the same for the same seed, whatever order the pool arrives in', () => {
    const a = planRun({ ...base, seed: 7 });
    const b = planRun({ ...base, seed: 7, freshUnseen: [...base.freshUnseen].reverse() });
    expect(b).toEqual(a);
  });

  it('differs between seeds', () => {
    const a = planRun({ ...base, seed: 7 });
    const b = planRun({ ...base, seed: 8 });
    expect(b.fresh).not.toEqual(a.fresh);
  });

  it('fills the length with core first and the fresh count after', () => {
    const plan = planRun({ ...base, seed: 1 });
    expect(plan.fresh).toHaveLength(7);
    expect(plan.core).toHaveLength(3);
    expect(new Set([...plan.core, ...plan.fresh]).size).toBe(10);
  });

  it('gives core what the fresh pool cannot fill, and works without core', () => {
    expect(planRun({ ...base, seed: 1, freshUnseen: ids(200, 4) }).core).toHaveLength(6);
    expect(planRun({ ...base, seed: 1, core: [] }).core).toEqual([]);
  });
});

describe('seededShuffle', () => {
  it('keeps every element', () => {
    expect(seededShuffle(ids(1, 30), 5).sort((a, b) => a - b)).toEqual(ids(1, 30));
  });
});

describe('scoreRun', () => {
  const rules = { passMark: 0.75, minFresh: 3 };

  it('ignores core answers', () => {
    const answers = [
      { fresh: false, correct: false },
      { fresh: false, correct: false },
      { fresh: true, correct: true },
      { fresh: true, correct: true },
      { fresh: true, correct: true },
      { fresh: true, correct: false },
    ];
    expect(scoreRun(answers, rules)).toEqual({ result: 'passed', score: 0.75 });
    expect(scoreRun(answers, { ...rules, passMark: 0.8 }).result).toBe('failed');
  });

  it('is void, not failed, below the fresh minimum', () => {
    const two = [
      { fresh: true, correct: true },
      { fresh: true, correct: true },
      { fresh: false, correct: true },
    ];
    expect(scoreRun(two, rules)).toEqual({ result: 'void', score: null });
    expect(scoreRun([], { passMark: 0, minFresh: 0 }).result).toBe('void');
  });
});

describe('poolFor', () => {
  it('is stable and exclusive per image', () => {
    for (const id of ids(1, 200)) expect(poolFor(id, 0.3)).toBe(poolFor(id, 0.3));
  });

  it('follows the share', () => {
    const hidden = ids(1, 4000).filter((id) => poolFor(id, 0.3) === 'hiddenCheck').length;
    expect(hidden / 4000).toBeGreaterThan(0.25);
    expect(hidden / 4000).toBeLessThan(0.35);
    expect(ids(1, 100).every((id) => poolFor(id, 0) === 'trials')).toBe(true);
    expect(ids(1, 100).every((id) => poolFor(id, 1) === 'hiddenCheck')).toBe(true);
  });
});
