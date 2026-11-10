import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A publish link is a GET anyone can craft, so the share it carries may only lower the stored
 * one; a raise renders the confirm step, which saves through the owner's own click.
 */

const share = vi.hoisted(() => ({
  setStudioDatasetShare: vi.fn(),
  getStudioDatasetShare: vi.fn(),
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: ({ resolver }: { resolver: unknown }) => resolver,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn().mockResolvedValue('tok'),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  getWorkflow: vi.fn().mockResolvedValue({ id: 'wf-1', tags: ['training'] }),
}));
vi.mock('~/server/services/orchestrator/training/publish-from-workflow', () => ({
  createDraftModelFromWorkflow: vi.fn().mockResolvedValue({
    modelId: 7,
    modelVersionId: 70,
    selectedEpoch: null,
  }),
  getPublishRefusalReason: vi.fn(),
  stampWorkflowDraftModel: vi.fn(),
}));
vi.mock('~/server/services/training-data-share.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...share,
}));

import { OnboardingSteps } from '~/server/common/enums';
import { getServerSideProps } from '~/pages/models/train/from-orchestrator';
import { dbMock } from '~/__tests__/mocks/db.mock';

const session = { user: { id: 5, muted: false, onboarding: OnboardingSteps.Buzz } };
const resolve = (query: Record<string, string>) =>
  (
    getServerSideProps as unknown as (
      args: unknown
    ) => Promise<{ props?: { confirmShare?: unknown }; redirect?: unknown }>
  )({
    session,
    ctx: {
      query: { workflowId: 'wf-1', epoch: '1', ...query },
      resolvedUrl: '/x',
      req: {},
      res: {},
    },
  });
const none = { ownRights: false, shareDataset: false };
const shared = { ownRights: true, shareDataset: true };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({ name: 'v1', baseModel: 'SDXL 1.0' });
  dbMock.dbWrite.modelFile.findFirst.mockResolvedValue(null);
});

describe('the publish link’s dataset share', () => {
  it('asks the owner to confirm a share instead of saving it', async () => {
    share.getStudioDatasetShare.mockResolvedValue(none);
    const result = await resolve({ ownRights: '1', shareDataset: '1' });
    // The link's own write is the lower-only one: no `raise`.
    expect(share.setStudioDatasetShare).toHaveBeenCalledWith(70, shared);
    expect(result.props?.confirmShare).toEqual({
      ...shared,
      modelVersionId: 70,
      continueUrl: '/models/train/from-orchestrator?workflowId=wf-1&epoch=1',
    });
  });

  it('goes straight on when the stored choice already allows it', async () => {
    share.getStudioDatasetShare.mockResolvedValue(shared);
    const result = await resolve({ ownRights: '1', shareDataset: '1' });
    expect(result.props?.confirmShare).toBeUndefined();
    expect(result.redirect).toBeDefined();
  });

  it('a rights answer without a share asks the owner to confirm it', async () => {
    share.getStudioDatasetShare.mockResolvedValue(none);
    const result = await resolve({ ownRights: '1', shareDataset: '0' });
    expect(result.props?.confirmShare).toMatchObject({
      ownRights: true,
      shareDataset: false,
      modelVersionId: 70,
    });
  });

  it('an un-tick is applied without a confirm', async () => {
    share.getStudioDatasetShare.mockResolvedValue(none);
    const result = await resolve({ ownRights: '0', shareDataset: '0' });
    expect(share.setStudioDatasetShare).toHaveBeenCalledWith(70, none);
    expect(result.props?.confirmShare).toBeUndefined();
  });

  it('a link with no choice writes nothing', async () => {
    await resolve({});
    expect(share.setStudioDatasetShare).not.toHaveBeenCalled();
  });
});
