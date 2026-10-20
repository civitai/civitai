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
  /** Ecosystem 0 'Krea 2 Turbo', 1 'Krea 2', 2 'SDXL 1.0'; `published` lists each resource's ids. */
  const index = (published: number[][]) =>
    ({
      ecosystems: [
        { name: 'Krea 2 Turbo', users: 0, observations: 0 },
        { name: 'Krea 2', users: 0, observations: 0 },
        { name: 'SDXL 1.0', users: 0, observations: 0 },
      ],
      kinds: { addon: { ecosystems: published }, checkpoint: { ecosystems: [] } },
    } as unknown as TagIndex);
  const fill = (n: number, ids: number[]) => Array.from({ length: n }, () => ids);
  const floor = V1_TAGS_MIN_ECOSYSTEM_RESOURCES;

  it("counts a resource published under several of an ecosystem's gate base models once", () => {
    const published = [...fill(floor - 1, [0, 1]), ...fill(floor, [2])];
    expect([...gateEligibleEcosystems(index(published), 'addon', ['LORA'])]).toEqual([2]);
  });

  it("counts the requested kind's resources, cached per kind", () => {
    const idx = {
      ...index(fill(floor, [2])),
      kinds: { addon: { ecosystems: fill(floor, [2]) }, checkpoint: { ecosystems: [] } },
    } as unknown as TagIndex;
    expect([...gateEligibleEcosystems(idx, 'addon', ['LORA'])]).toEqual([2]);
    expect([...gateEligibleEcosystems(idx, 'checkpoint', ['Checkpoint'])]).toEqual([]);
  });

  it('pools the resources of every base model in the gate, and reaches the floor exactly', () => {
    const published = [...fill(floor - 1, [1]), [0], ...fill(floor - 1, [2])];
    expect([...gateEligibleEcosystems(index(published), 'addon', ['LORA'])].sort()).toEqual([0, 1]);
  });
});
