import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hand-listed: the real module pulls nsfwLevels.service, whose search-index graph builds clients at load.
vi.mock('~/server/services/text-scan/rated-entities', () => ({
  applyRatingFloor: vi.fn(async () => ({ deferredRatingNotice: null })),
}));
// Hand-listed: the real action reaches rated-entities and bounty.service, whose graphs build clients at load.
vi.mock('~/server/services/text-scan/actions/bounty-nsfw', () => ({
  applyBountyNsfwTextScan: vi.fn(async () => ({ deferredRatingNotice: null })),
}));

// Hand-listed: the real action reaches nsfwLevels.service, whose search-index graph builds clients at load.
vi.mock('~/server/services/text-scan/actions/collection', () => ({
  applyCollectionTextScan: vi.fn(async () => undefined),
}));

// Hand-listed: the real action reaches model.service, whose graph builds clients at load.
vi.mock('~/server/services/text-scan/actions/model-rules', () => ({
  applyModelRulesTextScan: vi.fn(async () => undefined),
}));

const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
const { applyRatingFloor } = await import('~/server/services/text-scan/rated-entities');
const { applyBountyNsfwTextScan } = await import('~/server/services/text-scan/actions/bounty-nsfw');
const { applyCollectionTextScan } = await import('~/server/services/text-scan/actions/collection');

const { applyModelRulesTextScan } = await import('~/server/services/text-scan/actions/model-rules');

const args = {
  entityId: 1,
  workflowId: 'wf',
  outcome: { triggeredLabels: [], nsfwLevel: 4 },
  subject: { fields: [], declared: {} },
};

beforeEach(() => vi.clearAllMocks());

describe('rated-entity text-scan adapters', () => {
  it.each(['Post', 'BountyEntry'])('%s is registered and applies the floor', async (type) => {
    const adapter = getModerationAdapter(type);
    await adapter!.applyTextScan!(args as never);
    expect(applyRatingFloor).toHaveBeenCalledWith(type, args);
  });

  it('Bounty is registered and runs the bounty action', async () => {
    await getModerationAdapter('Bounty')!.applyTextScan!(args as never);
    expect(applyBountyNsfwTextScan).toHaveBeenCalledWith(args);
  });

  it('Collection is registered and runs the collection action', async () => {
    await getModerationAdapter('Collection')!.applyTextScan!(args as never);
    expect(applyCollectionTextScan).toHaveBeenCalledWith(args);
  });
});

describe('model-rules text-scan adapter', () => {
  it('ModelRules is registered and runs the model-rules action', async () => {
    await getModerationAdapter('ModelRules')!.applyTextScan!(args as never);
    expect(applyModelRulesTextScan).toHaveBeenCalledWith(args);
  });
});
