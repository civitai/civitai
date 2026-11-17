import { describe, expect, it } from 'vitest';
import { buildFilter } from '~/server/services/resource-select.service';
import type { GetResourceSelectInput } from '~/server/schema/model.schema';
import type { GetFeaturedModels } from '~/server/services/model.service';

const featuredModels: GetFeaturedModels = [
  { modelId: 1, modelVersionId: 10, position: 1, baseModel: 'Illustrious', type: 'LORA' },
  { modelId: 2, modelVersionId: 20, position: 1, baseModel: 'SDXL 1.0', type: 'Checkpoint' },
];

const filterFor = (resources: GetResourceSelectInput['resources']) =>
  buildFilter({
    input: {
      tab: 'featured',
      selectSource: 'generation',
      sort: 'relevance',
      limit: 20,
      resources,
      filterTypes: [],
      filterBaseModels: [],
      filterLoaded: false,
      filterTurbo: false,
      excludedVersionIds: [],
    },
    user: { id: 1, isModerator: false },
    featuredModels,
    tabIds: null,
    coverageNext: true,
    member: true,
  }) ?? '';

describe('the picker’s Featured tab', () => {
  it("keeps a LoRA search to the ecosystem's base models", () => {
    expect(filterFor([{ type: 'LORA', baseModels: ['ZImageTurbo'] }])).toContain(
      'versions.baseModel IN ["ZImageTurbo"]'
    );
  });

  it('lists featured checkpoints from every ecosystem', () => {
    expect(filterFor([{ type: 'Checkpoint', baseModels: ['ZImageTurbo'] }])).not.toContain(
      'versions.baseModel'
    );
  });
});
