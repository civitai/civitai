import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hand-listed: the real action reaches rated-entities and bounty.service, whose graphs build clients at load.
vi.mock('~/server/services/text-scan/actions/bounty-nsfw', () => ({
  applyBountyNsfwTextScan: vi.fn(async () => ({ deferredRatingNotice: null })),
}));

const { bountyModerationAdapter } = await import('~/server/services/bounty-moderation.adapter');
const { applyBountyNsfwTextScan } = await import('~/server/services/text-scan/actions/bounty-nsfw');

beforeEach(() => vi.clearAllMocks());

describe('bountyModerationAdapter', () => {
  it('hands an active verdict to the bounty nsfw action', async () => {
    const args = {
      entityId: 1,
      workflowId: 'wf',
      outcome: { triggeredLabels: [], nsfwLevel: 4 },
      subject: { fields: [], declared: {} },
    };
    await bountyModerationAdapter.applyTextScan!(args as never);
    expect(applyBountyNsfwTextScan).toHaveBeenCalledWith(args);
  });

  it('has no XGuard hook', () => {
    expect(bountyModerationAdapter.applyResult).toBeUndefined();
  });
});
