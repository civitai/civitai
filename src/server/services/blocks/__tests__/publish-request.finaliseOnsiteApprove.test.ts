import { beforeEach, describe, expect, it, vi } from 'vitest';

// The on-site approve's last step runs after the code is committed, so its hold check must be
// told so (afterSideEffects) and a late hold must re-suspend the block rather than refuse.

const { resolveHoldsAtApprove } = vi.hoisted(() => ({ resolveHoldsAtApprove: vi.fn() }));

vi.mock('~/env/server', () => ({ env: {} }));
vi.mock('~/server/services/blocks/publish-request-holds.service', () => ({
  resolveHoldsAtApprove,
}));

import { finaliseOnsiteApprove } from '~/server/services/blocks/publish-request.service';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

const SHA = 'a'.repeat(40);

function fakeTx() {
  return {
    appBlockPublishRequest: { update: vi.fn(async () => ({})) },
    appBlock: { update: vi.fn(async () => ({})) },
  };
}

const input = {
  holdDecision: { slug: 'app-a', overrideReason: null, shownHoldIds: [] },
  reviewerUserId: 901,
  publishRequestId: 'pubreq_a',
  appBlockId: 'apb_1',
  forgejoCommitSha: SHA,
  screenshots: [],
};

beforeEach(() => vi.clearAllMocks());

describe('finaliseOnsiteApprove', () => {
  it('🔴 runs the final hold check as past the point of no return', async () => {
    resolveHoldsAtApprove.mockResolvedValue({ overridden: [], late: [] });
    await finaliseOnsiteApprove(fakeTx() as never, input);
    expect(resolveHoldsAtApprove).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ slug: 'app-a', actorUserId: 901, afterSideEffects: true })
    );
  });

  it('🔴 a late hold re-suspends the block in the same transaction, and the request is still approved', async () => {
    resolveHoldsAtApprove.mockResolvedValue({ overridden: [], late: [12] });
    const tx = fakeTx();
    await expect(finaliseOnsiteApprove(tx as never, input)).resolves.toEqual({
      lateHoldIds: [12],
    });
    expect(tx.appBlock.update).toHaveBeenCalledWith({
      where: { id: 'apb_1' },
      data: expect.objectContaining({ currentVersionSha: SHA, status: 'suspended' }),
    });
    expect(tx.appBlockPublishRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'approved' }) })
    );
  });

  it('leaves the block status alone with no late hold', async () => {
    resolveHoldsAtApprove.mockResolvedValue({ overridden: [3], late: [] });
    const tx = fakeTx();
    await finaliseOnsiteApprove(tx as never, input);
    const [{ data }] = tx.appBlock.update.mock.calls[0] as unknown as [{ data: object }];
    expect(data).not.toHaveProperty('status');
  });
});
