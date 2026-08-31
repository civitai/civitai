import { describe, expect, it } from 'vitest';
import {
  baseModelByName,
  ecosystemById,
  getCompatibleBaseModels,
  ecosystemByKey,
} from '~/shared/constants/basemodel.constants';
import { generationGraph } from './generation-graph';
import { ltxVersionOptions } from './ltx-graph';
import type { VersionOption } from './common';
import type { GenerationCtx } from './context';

const ext: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  gateRules: [],
};

/** Ecosystem each top-level version option is expected to select. */
const expectedEcosystemByLabel: Record<string, string> = {
  '2.0': 'LTXV2',
  '2.3': 'LTXV23',
  '2.5': 'LTXV25',
  'Sulphur 2': 'LTXV23',
};

function flatten(option: VersionOption): VersionOption[] {
  return [option, ...(option.children?.options.flatMap(flatten) ?? [])];
}

describe('ltxVersionOptions baseModel names', () => {
  // `createCheckpointGraph` resolves an option's ecosystem with
  // `baseModelByName.get(option.baseModel)`. An unregistered name resolves to
  // undefined and the ecosystem-switch effect bails out silently, stranding the
  // user on whichever LTX ecosystem they were already on.
  it.each(Object.keys(expectedEcosystemByLabel))('%s maps to its ecosystem', (label) => {
    const top = ltxVersionOptions.options.find((o) => o.label === label);
    expect(top, `no top-level option labelled ${label}`).toBeDefined();

    for (const option of flatten(top!)) {
      const record = baseModelByName.get(option.baseModel ?? '');
      expect(record, `unregistered baseModel ${option.baseModel}`).toBeDefined();
      expect(ecosystemById.get(record!.ecosystemId)?.key).toBe(expectedEcosystemByLabel[label]);
    }
  });
});

describe('LTX ecosystem switching', () => {
  it('switches back to LTXV23 when a 2.3 version is picked from LTXV25', () => {
    const v25 = ltxVersionOptions.options.find((o) => o.label === '2.5')!;
    const v23 = ltxVersionOptions.options.find((o) => o.label === '2.3')!;
    const graph = generationGraph as any;

    graph.init(
      {
        workflow: 'txt2vid',
        ecosystem: 'LTXV25',
        model: { id: v25.value, baseModel: v25.baseModel, model: { type: 'Checkpoint' } },
      },
      ext
    );
    expect(graph.getSnapshot().ecosystem).toBe('LTXV25');

    graph.set({
      model: { id: v23.value, baseModel: v23.baseModel, model: { type: 'Checkpoint' } },
    });
    expect(graph.getSnapshot().ecosystem).toBe('LTXV23');
  });
});

describe('LTXV25 resource compatibility', () => {
  it('accepts LTXV 2.3 LoRAs as partially compatible', () => {
    const ltxv25 = ecosystemByKey.get('LTXV25')!;
    const { full, partial } = getCompatibleBaseModels(ltxv25.id, 'LORA');

    expect(partial.map((m) => m.name)).toContain('LTXV 2.3');
    expect(full.map((m) => m.name)).not.toContain('LTXV 2.3');
    expect(full.map((m) => m.name)).toContain('LTXV 2.5');
  });
});
