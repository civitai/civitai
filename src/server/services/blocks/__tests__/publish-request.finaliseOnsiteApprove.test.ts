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
import { resetRestoreWhere } from '~/server/services/blocks/publish-request.service';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

const SHA = 'a'.repeat(40);

function fakeTx() {
  return {
    appBlockPublishRequest: { update: vi.fn(async () => ({})) },
    appBlock: {
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => ({ appId: 'appblk-app-a', status: 'suspended' })),
      count: vi.fn(async () => 0),
    },
    apiKey: {
      findMany: vi.fn(async () => [{ userId: 7 }]),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
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
      revokedTokens: { clientId: 'appblk-app-a', userIds: [7] },
    });
    // The held sha is not marked current, so no restore or rebuild can serve it.
    expect(tx.appBlock.update).toHaveBeenCalledWith({
      where: { id: 'apb_1', status: { notIn: ['remix', 'remix_disabled'] } },
      data: { status: 'suspended' },
    });
    // 🔴 The held request stays pending, so the next version is reviewed against the live one.
    expect(tx.appBlockPublishRequest.update).not.toHaveBeenCalled();
  });

  it('🔴 a late hold revokes the app tokens in the same transaction; no late hold revokes none', async () => {
    const late = fakeTx();
    resolveHoldsAtApprove.mockResolvedValue({ overridden: [], late: [12] });
    await finaliseOnsiteApprove(late as never, input);
    expect(late.apiKey.deleteMany).toHaveBeenCalledWith({
      where: { clientId: 'appblk-app-a', type: { in: ['Access', 'Refresh'] } },
    });
    // The client's block rows are locked before the re-suspend, so a concurrent suspension waits on it.
    expect(late.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      late.appBlock.update.mock.invocationCallOrder[0]
    );

    const clean = fakeTx();
    resolveHoldsAtApprove.mockResolvedValue({ overridden: [], late: [] });
    await finaliseOnsiteApprove(clean as never, input);
    expect(clean.apiKey.deleteMany).not.toHaveBeenCalled();
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
      priorVersion: { block, oauthClientId: 'oc_1', allowedScopes: 5n },
    });
    expect(tx.appBlock.update).toHaveBeenCalledWith({
      where: { id: 'apb_1', status: { notIn: ['remix', 'remix_disabled'] } },
      data: { status: 'suspended', ...block },
    });
    expect(tx.oauthClient.update).toHaveBeenCalledWith({
      where: { id: 'oc_1' },
      data: { allowedScopes: 5n },
    });
  });

  it('🔴 a late hold after the listing sync puts the prior copy back, pending re-approve', async () => {
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
    const priorListing = await snapshotOnsiteListing(tx as never, 'app-a', {
      sourceRepoAvailable: true,
      issueTrackerAvailable: true,
    });

    await finaliseOnsiteApprove(tx as never, { ...input, priorListing });

    const { id, ...fields } = before;
    // Prior copy back, in the shape the post-hold re-approve restores (it un-suspends the block).
    const reset = resetRestoreWhere('apb_1');
    expect(tx.appListing.update).toHaveBeenCalledWith({
      where: { id },
      data: { ...fields, status: reset.status, appBlockId: reset.appBlockId },
    });
    // The issue-tracker link goes back too (a raw write: the column is guarded).
    expect(tx.$executeRaw).toHaveBeenCalledWith(
      expect.anything(),
      'https://example.test/old',
      'al_1'
    );
  });

  it('🔴 a delisted app keeps its removed listing on a late hold, so the re-approve never republishes it', async () => {
    resolveHoldsAtApprove.mockResolvedValue({ overridden: [], late: [12] });
    const tx = fakeTx();
    const removed = {
      id: 'al_1',
      status: 'removed',
      contentRating: 'pg',
      name: 'n',
      tagline: null,
      description: null,
      category: null,
      appBlockId: 'apb_1',
    };
    await finaliseOnsiteApprove(tx as never, { ...input, priorListing: removed });
    const [[{ data }]] = tx.appListing.update.mock.calls as unknown as [
      [{ data: { status: string } }]
    ];
    expect(data.status).toBe('removed');
    // The reset-restore lookup the re-approve uses cannot match it.
    expect(data.status).not.toBe(resetRestoreWhere('apb_1').status);
  });

  it('🔴 the snapshot never names a manual-apply column that is not there yet', async () => {
    const tx = fakeTx();
    tx.appListing.findUnique.mockResolvedValueOnce({ id: 'al_1', kind: 'onsite', name: 'n' });
    const prior = await snapshotOnsiteListing(tx as never, 'app-a', {
      sourceRepoAvailable: false,
      issueTrackerAvailable: false,
    });
    const [{ select }] = tx.appListing.findUnique.mock.calls[0] as unknown as [
      { select: Record<string, boolean> }
    ];
    // Naming a missing column throws, which would fail the whole approve.
    expect(select).not.toHaveProperty('sourceRepoUrl');
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(prior).not.toHaveProperty('issueTracker');
  });

  it('🔴 a listing the approve created is left for the post-hold re-approve to publish', async () => {
    resolveHoldsAtApprove.mockResolvedValue({ overridden: [], late: [12] });
    const tx = fakeTx();
    await finaliseOnsiteApprove(tx as never, input);
    const reset = resetRestoreWhere('apb_1');
    expect(tx.appListing.updateMany).toHaveBeenCalledWith({
      where: { appBlockId: reset.appBlockId, kind: reset.kind },
      data: { status: reset.status },
    });
  });

  it('🔴 a draft-at-submit snapshot is not put back as a draft (that re-approve would leave the block suspended)', async () => {
    resolveHoldsAtApprove.mockResolvedValue({ overridden: [], late: [12] });
    const tx = fakeTx();
    const draft = {
      id: 'al_1',
      status: 'draft',
      contentRating: null,
      name: 'n',
      tagline: null,
      description: null,
      category: null,
      appBlockId: null,
    };
    await finaliseOnsiteApprove(tx as never, { ...input, priorListing: draft });
    const [[{ data }]] = tx.appListing.update.mock.calls as unknown as [[{ data: object }]];
    expect(data).toMatchObject({ status: 'pending', appBlockId: 'apb_1' });
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
        allowedScopes: 5n,
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
