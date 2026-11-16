import { beforeEach, describe, expect, it, vi } from 'vitest';

// The on-site approve's last step runs after the code is committed, so its hold check must be
// told so (afterSideEffects) and a late hold must re-suspend the block rather than refuse.

const { resolveHoldsAtApprove } = vi.hoisted(() => ({ resolveHoldsAtApprove: vi.fn() }));

vi.mock('~/env/server', () => ({ env: {} }));
vi.mock('~/server/services/blocks/publish-request-holds.service', () => ({
  resolveHoldsAtApprove,
}));

import {
  finaliseOnsiteApprove,
  snapshotOnsiteListing,
} from '~/server/services/blocks/publish-request-finalise.service';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

const SHA = 'a'.repeat(40);

function fakeTx() {
  return {
    appBlockPublishRequest: { update: vi.fn(async () => ({})) },
    appBlock: { update: vi.fn(async () => ({})) },
    oauthClient: { update: vi.fn(async () => ({})) },
    appListing: {
      findUnique: vi.fn(async (): Promise<unknown> => null),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $queryRaw: vi.fn(async (): Promise<unknown> => []),
    $executeRaw: vi.fn(async () => 1),
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

  it('🔴 a late hold re-suspends the block in the same transaction and leaves the request pending', async () => {
    resolveHoldsAtApprove.mockResolvedValue({ overridden: [], late: [12] });
    const tx = fakeTx();
    await expect(finaliseOnsiteApprove(tx as never, input)).resolves.toEqual({
      lateHoldIds: [12],
    });
    // The held sha is not marked current, so no restore or rebuild can serve it.
    expect(tx.appBlock.update).toHaveBeenCalledWith({
      where: { id: 'apb_1' },
      data: { status: 'suspended' },
    });
    // 🔴 The held request stays pending, so the next version is reviewed against the live one.
    expect(tx.appBlockPublishRequest.update).not.toHaveBeenCalled();
  });

  it('🔴 a late hold puts back the manifest, scopes and tier the app ran under', async () => {
    resolveHoldsAtApprove.mockResolvedValue({ overridden: [], late: [12] });
    const tx = fakeTx();
    const block = {
      manifest: { scopes: ['old'] },
      version: '1.0.0',
      approvedScopes: ['old'],
      contentRating: 'pg',
      renderMode: 'iframe',
      trustTier: 'unverified',
    };
    await finaliseOnsiteApprove(tx as never, {
      ...input,
      priorVersion: { block, oauthClientId: 'oc_1', allowedScopes: 5 },
    });
    expect(tx.appBlock.update).toHaveBeenCalledWith({
      where: { id: 'apb_1' },
      data: { status: 'suspended', ...block },
    });
    expect(tx.oauthClient.update).toHaveBeenCalledWith({
      where: { id: 'oc_1' },
      data: { allowedScopes: 5 },
    });
  });

  it('🔴 a late hold after the listing sync leaves the listing as it was before the approve', async () => {
    resolveHoldsAtApprove.mockResolvedValue({ overridden: [], late: [12] });
    const tx = fakeTx();
    const before = {
      id: 'al_1',
      status: 'approved',
      contentRating: 'pg',
      name: 'Old name',
      tagline: 'Old tagline',
      description: 'Old description',
      category: 'tools',
      sourceRepoUrl: null,
      appBlockId: 'apb_1',
    };
    tx.appListing.findUnique.mockResolvedValueOnce({ ...before, kind: 'onsite' });
    tx.$queryRaw.mockResolvedValueOnce([{ issueTrackerUrl: 'https://example.test/old' }]);
    const priorListing = await snapshotOnsiteListing(tx as never, 'app-a');

    await finaliseOnsiteApprove(tx as never, { ...input, priorListing });

    const { id, ...fields } = before;
    expect(tx.appListing.update).toHaveBeenCalledWith({ where: { id }, data: fields });
    // The issue-tracker link goes back too (a raw write: the column is guarded).
    expect(tx.$executeRaw).toHaveBeenCalledWith(
      expect.anything(),
      'https://example.test/old',
      'al_1'
    );
  });

  it('🔴 a listing the approve created goes back to a draft on a late hold', async () => {
    resolveHoldsAtApprove.mockResolvedValue({ overridden: [], late: [12] });
    const tx = fakeTx();
    await finaliseOnsiteApprove(tx as never, input);
    expect(tx.appListing.updateMany).toHaveBeenCalledWith({
      where: { appBlockId: 'apb_1', kind: 'onsite' },
      data: { status: 'draft' },
    });
  });

  it('touches no listing without a late hold', async () => {
    resolveHoldsAtApprove.mockResolvedValue({ overridden: [], late: [] });
    const tx = fakeTx();
    await finaliseOnsiteApprove(tx as never, input);
    expect(tx.appListing.update).not.toHaveBeenCalled();
    expect(tx.appListing.updateMany).not.toHaveBeenCalled();
  });

  it('writes no prior fields back without a late hold', async () => {
    resolveHoldsAtApprove.mockResolvedValue({ overridden: [], late: [] });
    const tx = fakeTx();
    await finaliseOnsiteApprove(tx as never, {
      ...input,
      priorVersion: {
        block: {
          manifest: {},
          version: '1.0.0',
          approvedScopes: [],
          contentRating: 'pg',
          renderMode: 'iframe',
          trustTier: 'unverified',
        },
        oauthClientId: 'oc_1',
        allowedScopes: 5,
      },
    });
    const [{ data }] = tx.appBlock.update.mock.calls[0] as unknown as [{ data: object }];
    expect(data).not.toHaveProperty('approvedScopes');
    expect(tx.oauthClient.update).not.toHaveBeenCalled();
  });

  it('leaves the block status alone with no late hold', async () => {
    resolveHoldsAtApprove.mockResolvedValue({ overridden: [3], late: [] });
    const tx = fakeTx();
    await finaliseOnsiteApprove(tx as never, input);
    const [{ data }] = tx.appBlock.update.mock.calls[0] as unknown as [{ data: object }];
    expect(data).not.toHaveProperty('status');
    expect(data).toMatchObject({ currentVersionSha: SHA });
    expect(tx.appBlockPublishRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'approved' }) })
    );
  });
});
