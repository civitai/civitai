import { BaseSequencer } from 'vitest/node';
import { describe, expect, it } from 'vitest';

import { assignShards } from '../test-shard/assign.mjs';
import TimingShardSequencer, { isUnitRun, loadTimings } from '../test-shard/sequencer.mjs';
import { buildTimings, fileCost } from '../test-shard/update-timings.mjs';

const table = (costs: Record<string, number>) => (key: string) => costs[key];

describe('assignShards', () => {
  it('places heaviest first onto the least-loaded shard (LPT)', () => {
    // a(10)->0, b(9)->1, c(8)->1 (9 < 10), d(3)->0 (10 < 17), e(2)->0 (13 < 17)
    const keys = ['e', 'c', 'a', 'd', 'b'];
    const out = assignShards(keys, table({ a: 10, b: 9, c: 8, d: 3, e: 2 }), 2);
    expect(out).toEqual([0, 1, 0, 0, 1]);
  });

  it('beats a count split on a skewed suite', () => {
    // Two heavy files and six light ones: a count split can put both heavies on one shard.
    const costs = { h1: 100, h2: 100, l1: 1, l2: 1, l3: 1, l4: 1, l5: 1, l6: 1 };
    const out = assignShards(Object.keys(costs), table(costs), 2);
    const loads = [0, 0];
    Object.keys(costs).forEach((k, i) => (loads[out[i]] += costs[k as keyof typeof costs]));
    expect(loads).toEqual([103, 103]);
  });

  it('deals files with no recorded cost round-robin, in key order', () => {
    const out = assignShards(['u3', 'u1', 'u5', 'u2', 'u4'], () => undefined, 2);
    // sorted u1..u5 -> 0,1,0,1,0
    expect(out).toEqual([0, 0, 0, 1, 1]);
  });

  it('treats a non-finite or negative cost as unknown', () => {
    const costs: Record<string, number> = { a: Number.NaN, b: -5, c: Infinity };
    expect(assignShards(['a', 'b', 'c'], table(costs), 3)).toEqual([0, 1, 2]);
  });

  it('is a partition independent of input order, at every width', () => {
    const keys = Array.from({ length: 257 }, (_, i) => `src/f${String(i).padStart(3, '0')}.test.ts`);
    // Deterministic, pairwise-distinct-ish costs with deliberate ties, plus some unknowns.
    const cost = (k: string) => {
      const n = Number(k.slice(5, 8));
      return n % 7 === 0 ? undefined : (n * 37) % 101;
    };
    const reversed = [...keys].reverse();
    for (const count of [1, 2, 3, 4, 6, 8]) {
      const a = assignShards(keys, cost, count);
      const b = assignShards(reversed, cost, count);
      const byKeyA = new Map(keys.map((k, i) => [k, a[i]]));
      const byKeyB = new Map(reversed.map((k, i) => [k, b[i]]));
      expect(byKeyB, `count=${count}`).toEqual(byKeyA);
      for (const s of a) expect(Number.isInteger(s) && s >= 0 && s < count).toBe(true);
      // every shard gets something at these sizes
      expect(new Set(a).size).toBe(count);
    }
  });

  it('rejects a bad count and duplicate keys', () => {
    expect(() => assignShards(['a'], () => 1, 0)).toThrow(/shard count/);
    expect(() => assignShards(['a', 'a'], () => 1, 2)).toThrow(/unique/);
  });
});

type FakeSpec = { project: { name: string }; moduleId: string };
const spec = (project: string, rel: string): FakeSpec => ({
  project: { name: project },
  moduleId: `/repo/${rel}`,
});
const seq = (index: number, count: number) =>
  new TimingShardSequencer({ config: { root: '/repo', shard: { index, count } } } as never);

describe('TimingShardSequencer', () => {
  const unitFiles = [
    ...Array.from({ length: 40 }, (_, i) => spec('unit', `src/a/f${i}.test.ts`)),
    spec('unit-native', 'src/b/native.test.ts'),
  ];

  it('splits a unit run into disjoint slices that cover every file', async () => {
    for (const count of [1, 4, 6]) {
      const slices = await Promise.all(
        Array.from({ length: count }, (_, i) => seq(i + 1, count).shard(unitFiles as never))
      );
      const all = slices.flat();
      expect(all.length, `count=${count}`).toBe(unitFiles.length);
      expect(new Set(all).size).toBe(unitFiles.length);
    }
  });

  it('leaves a non-unit run on Vitest’s own split', async () => {
    // Enough files that a round-robin split and Vitest's hash split cannot coincide by luck (a
    // two-file fixture did, and let a mutant that dropped the guard survive).
    const files = [
      ...Array.from({ length: 12 }, (_, i) => spec('component', `src/c${i}.browser.test.tsx`)),
      spec('unit', 'src/y.test.ts'),
    ];
    let differsFromRoundRobin = false;
    for (const index of [1, 2, 3]) {
      const ours = await seq(index, 3).shard(files as never);
      const theirs = await new BaseSequencer({
        config: { root: '/repo', shard: { index, count: 3 } },
      } as never).shard(files as never);
      expect(ours).toEqual(theirs);
      const rr = files.filter((_, i) => assignShards(
        files.map((f) => `${f.project.name}\0${f.moduleId}`), () => undefined, 3)[i] === index - 1);
      if (rr.length !== theirs.length || rr.some((f, i) => f !== theirs[i])) differsFromRoundRobin = true;
    }
    // Control: the fixture must be one where the two splits disagree, or this test proves nothing.
    expect(differsFromRoundRobin).toBe(true);
    expect(isUnitRun(files as never)).toBe(false);
    expect(isUnitRun(unitFiles as never)).toBe(true);
    expect(isUnitRun([])).toBe(false);
  });

  it('ships a cost table that loads (otherwise every CI split is silently round-robin)', () => {
    expect(loadTimings().size).toBeGreaterThan(1000);
  });
});

describe('update-timings', () => {
  it('costs a file as its whole worker time and takes the median across runs', () => {
    const f = { file: 'a', env: 1, prepare: 2, collect: 30, setup: 4, duration: 50 };
    expect(fileCost(f)).toBe(87);
    const perfs = [
      { files: [f, { file: 'b', collect: 10 }] },
      { files: [{ ...f, collect: 130 }] },
      { files: [{ ...f, collect: 230 }] },
    ];
    expect(buildTimings(perfs, { rounds: 0 }).files).toEqual({ a: 187, b: 10 });
  });

  it('divides out a uniformly slow runner, including for files only it measured', () => {
    const run = (speed: number, files: Record<string, number>) => ({
      files: Object.entries(files).map(([file, collect]) => ({ file, collect: collect * speed })),
    });
    const perfs = [
      run(1, { a: 1000, b: 2000, c: 4000 }),
      run(1, { a: 1000, b: 2000, d: 3000 }),
      // 2x slower runner: shares a and b with the others; e is measured only here.
      run(2, { a: 1000, b: 2000, e: 5000 }),
    ];
    const { files, factors } = buildTimings(perfs);
    expect(factors.map((f) => Number(f.toFixed(6)))).toEqual([1, 1, 2]);
    expect(files).toEqual({ a: 1000, b: 2000, c: 4000, d: 3000, e: 5000 });
    // Raw, e would be recorded at twice its cost.
    expect(buildTimings(perfs, { rounds: 0 }).files.e).toBe(10000);
  });
});
