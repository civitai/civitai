import { describe, expect, it } from 'vitest';

import {
  ecosystemBaseModelGate,
  gateEligibleEcosystems,
  V1_TAGS_MIN_ECOSYSTEM_RESOURCES,
} from '~/server/services/resource-intent-tags/gate';
import type { TagIndex } from '~/server/services/resource-intent-tags/score';

describe('ecosystemBaseModelGate', () => {
  it.each([
    ['Krea 2 Turbo', 'Krea 2'],
    ['SDXL Lightning', 'SDXL 1.0'],
    ['NoobAI', 'Illustrious'],
  ])('%s admits %s add-ons', (ecosystem, sibling) => {
    const gate = ecosystemBaseModelGate(ecosystem, ['LORA']);
    expect(gate.get('LORA')).toEqual(expect.arrayContaining([ecosystem, sibling]));
  });

  it('is per model type: a cross-ecosystem rule scoped to one type admits nothing for another', () => {
    const gate = ecosystemBaseModelGate('SDXL 1.0', ['LORA', 'TextualInversion']);
    expect(gate.get('TextualInversion')).toContain('SD 1.5');
    expect(gate.get('LORA')).not.toContain('SD 1.5');
  });

  it('a name with no base-model record gates by that name alone', () => {
    expect([...ecosystemBaseModelGate('Not A Base Model', ['LORA', 'DoRA'])]).toEqual([
      ['LORA', ['Not A Base Model']],
      ['DoRA', ['Not A Base Model']],
    ]);
  });
});

describe('gateEligibleEcosystems', () => {
  /**
   * Ecosystem 0 'Krea 2 Turbo', 1 'Krea 2', 2 'SDXL 1.0'. `published` lists each resource's ids;
   * `used` is each ecosystem's user-side compatibility set (resource indices).
   */
  const index = (published: number[][], used: Record<number, number[]> = {}) => {
    const kind = {
      ecosystems: published,
      userByEcosystem: new Map(
        Object.entries(used).map(([id, rs]) => [Number(id), { resource: Uint32Array.from(rs) }])
      ),
    };
    return {
      ecosystems: [
        { name: 'Krea 2 Turbo', users: 0, observations: 0 },
        { name: 'Krea 2', users: 0, observations: 0 },
        { name: 'SDXL 1.0', users: 0, observations: 0 },
      ],
      kinds: { addon: kind, checkpoint: { ecosystems: [], userByEcosystem: new Map() } },
    } as unknown as TagIndex;
  };
  const fill = (n: number, ids: number[]) => Array.from({ length: n }, () => ids);
  const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);
  const floor = V1_TAGS_MIN_ECOSYSTEM_RESOURCES;
  const eligible = (idx: TagIndex) =>
    [...gateEligibleEcosystems(idx, 'addon', ['LORA'])].sort((a, b) => a - b);

  it('🔴 counts only the pool the scorer ranks from, not the whole catalogue under the gate', () => {
    // Krea 2 Turbo's gate admits all of Krea 2's catalogue, but only 10 of it is used with Krea 2 Turbo.
    expect(eligible(index(fill(floor + 50, [1]), { 0: range(0, 10) }))).toEqual([1]);
  });

  it('pools resources published under its own name with used ones published under its gate', () => {
    // 1 own + (floor - 1) of Krea 2's used with it: exactly the floor.
    const atFloor = [[0], ...fill(floor - 1, [1])];
    expect(eligible(index(atFloor, { 0: range(1, floor - 1) }))).toEqual([0]);
    // 1 own + (floor - 2) of Krea 2's + 5 SDXL ones its gate does not admit: one short.
    const short = [[0], ...fill(floor - 2, [1]), ...fill(5, [2])];
    expect(eligible(index(short, { 0: [...range(1, floor - 2), ...range(floor - 1, 5)] }))).toEqual(
      []
    );
  });

  it('counts a resource both published under its name and used with it once', () => {
    expect(eligible(index(fill(floor - 1, [0, 1]), { 0: range(0, floor - 1) }))).toEqual([]);
    expect(eligible(index(fill(floor, [0, 1]), { 0: range(0, floor) }))).toEqual([0, 1]);
  });

  it("counts the requested kind's resources, cached per kind", () => {
    const idx = index(fill(floor, [2]));
    expect([...gateEligibleEcosystems(idx, 'addon', ['LORA'])]).toEqual([2]);
    expect([...gateEligibleEcosystems(idx, 'checkpoint', ['Checkpoint'])]).toEqual([]);
  });
});
