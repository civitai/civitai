import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NotifyModule from '~/server/services/text-scan/notify';

// Hand-listed: the real action reaches rated-entities and bounty.service, whose graphs build clients at load.
vi.mock('~/server/services/text-scan/actions/bounty-nsfw', () => ({
  applyBountyNsfwTextScan: vi.fn(async () => ({ deferredRatingNotice: null })),
}));

// Hand-listed: the real action reaches report.service and notification.service, which build clients
// at load.
vi.mock('~/server/services/text-scan/actions/bounty-poi', () => ({
  applyBountyPoi: vi.fn(async () => ({ notified: false })),
}));
vi.mock('~/server/services/text-scan/notify', async (importOriginal) => ({
  ...(await importOriginal<typeof NotifyModule>()),
  notifyTextScanRatingRaised: vi.fn(),
}));

const { bountyModerationAdapter } = await import('~/server/services/bounty-moderation.adapter');
const { applyBountyNsfwTextScan } = await import('~/server/services/text-scan/actions/bounty-nsfw');
const { applyBountyPoi } = await import('~/server/services/text-scan/actions/bounty-poi');
const { notifyTextScanRatingRaised } = await import('~/server/services/text-scan/notify');

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

describe('bounty applyTextScan — poi and the deferred rating notice', () => {
  const args = {
    entityId: 1,
    workflowId: 'wf-1',
    outcome: { triggeredLabels: [], nsfwLevel: null },
    subject: { fields: [], declared: {} },
    textHash: 'h',
  };
  const notice = {
    entityType: 'Bounty',
    entityId: 1,
    userId: 42,
    level: 4,
    title: 'B',
    url: '/bounties/1',
    workflowId: 'wf-1',
  };

  it('hands the same args to the poi action after nsfw', async () => {
    await bountyModerationAdapter.applyTextScan!(args as never);
    expect(applyBountyPoi).toHaveBeenCalledWith(args);
    expect(vi.mocked(applyBountyNsfwTextScan).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(applyBountyPoi).mock.invocationCallOrder[0]
    );
  });

  // Review Focus 6.
  it('sends the deferred rating notice when the poi action notified nobody', async () => {
    vi.mocked(applyBountyNsfwTextScan).mockResolvedValueOnce({ deferredRatingNotice: notice });
    await bountyModerationAdapter.applyTextScan!(args as never);
    expect(notifyTextScanRatingRaised).toHaveBeenCalledWith(notice);
  });

  it('drops the deferred notice when the owner already got the poi notice', async () => {
    vi.mocked(applyBountyNsfwTextScan).mockResolvedValueOnce({ deferredRatingNotice: notice });
    vi.mocked(applyBountyPoi).mockResolvedValueOnce({ notified: true });
    await bountyModerationAdapter.applyTextScan!(args as never);
    expect(notifyTextScanRatingRaised).not.toHaveBeenCalled();
  });
});
