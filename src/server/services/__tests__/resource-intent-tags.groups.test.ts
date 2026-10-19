import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { keptWeights, requestGroups } from '~/server/services/resource-intent-tags/groups';

/**
 * Request-time grouping against the vocabulary miner's golden fixture, whose expected values were
 * worked out by hand from the rule. The `tags` and `cases` are byte-identical to the miner's fixture at
 * its commit 8e68c98a8b3d (2026-10-16). Never edit a case to make this pass. Each case's `gatedGroups`
 * (the miner's post-gate group order) is not asserted: the V1 score reads only the per-tag weights,
 * so that ordering is not ported.
 */
type Case = {
  name: string;
  tagIds: number[];
  keptIds: number[];
  groups: number[][];
  keptWeights: [number, number][];
};
const golden = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/resource-intent-tags-request-groups-golden.json'), 'utf8')
) as { schema: string; tags: { key: string; idf: number; near: number[] }[]; cases: Case[] };

const round9 = (x: number) => Math.round(x * 1e9) / 1e9;

describe('resource-intent-tags request grouping (miner golden)', () => {
  it('the fixture is the one this test was written for', () => {
    expect(golden.schema).toBe('p2m-vocab/2');
    expect(golden.tags.length).toBe(18);
    expect(golden.cases.length).toBe(27);
  });

  it.each(golden.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(requestGroups(c.tagIds, golden.tags)).toEqual(c.groups);
    const w = keptWeights(c.tagIds, c.keptIds, golden.tags);
    expect([...w].sort((a, b) => a[0] - b[0]).map(([i, x]) => [i, round9(x)])).toEqual(
      c.keptWeights
    );
  });

  it('refuses a kept id that was not found, and an id outside the vocabulary', () => {
    expect(() => keptWeights([0], [0, 1], golden.tags)).toThrow(/kept ids not among the found/);
    expect(() => requestGroups([0, 18], golden.tags)).toThrow(/not in the vocabulary/);
  });
});
