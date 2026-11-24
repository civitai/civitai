import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Workflows from '~/server/services/orchestrator/workflows';

/**
 * The from-orchestrator page's server side: a run that can't be published renders the reason
 * instead of bouncing the user to the /models feed. `createDraftModelFromWorkflow` and its checks
 * run for real; the session wrapper, the orchestrator read and the DB are faked.
 */

const { mockGetWorkflow } = vi.hoisted(() => ({ mockGetWorkflow: vi.fn() }));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: ({ resolver }: { resolver: unknown }) => resolver,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn().mockResolvedValue('tok'),
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: mockGetWorkflow,
  updateWorkflow: vi.fn(),
}));

import type { Workflow } from '@civitai/orchestration-client';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { OnboardingSteps } from '~/server/common/enums';
import { getServerSideProps } from '~/pages/models/train/from-orchestrator';
import { dbMock } from '~/__tests__/mocks/db.mock';

const session = { user: { id: 5, muted: false, onboarding: OnboardingSteps.Buzz } };

function run(
  moderationStatus: string | undefined,
  { epochs = true, input = { ecosystem: 'sdxl' } as Record<string, string> } = {}
): Workflow {
  return {
    id: 'wf-1',
    tags: ['training'],
    steps: [
      {
        $type: 'training',
        input,
        output: {
          ...(moderationStatus !== undefined && { moderationStatus }),
          epochs: epochs
            ? [{ epochNumber: 1, model: { url: 'https://blobs/epoch-1', available: true } }]
            : [],
        },
      },
    ],
  } as unknown as Workflow;
}

const resolve = (s: unknown = session, query: Record<string, string> = {}) =>
  (getServerSideProps as unknown as (args: unknown) => Promise<unknown>)({
    session: s,
    ctx: {
      query: { workflowId: 'wf-1', epoch: '1', ...query },
      resolvedUrl: '/x',
      req: {},
      res: {},
    },
  });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.model.findFirst.mockResolvedValue(null);
});

describe('from-orchestrator SSR — refusals render a reason', () => {
  it.each(['evaluating', 'underReview', 'rejected', undefined])(
    'renders the not-approved explanation for a run whose status is %s',
    async (status) => {
      mockGetWorkflow.mockResolvedValue(run(status));
      await expect(resolve()).resolves.toEqual({ props: { session, refusal: 'not-approved' } });
    }
  );

  it('explains a base model the main app cannot publish', async () => {
    mockGetWorkflow.mockResolvedValue(
      run('approved', {
        input: {
          ecosystem: 'not-a-real-eco',
          model: 'urn:air:other:checkpoint:civitai:1@1',
        },
      })
    );
    await expect(resolve()).resolves.toEqual({ props: { session, refusal: 'unsupported-base' } });
  });

  it('explains a run with no downloadable checkpoint', async () => {
    mockGetWorkflow.mockResolvedValue(run('approved', { epochs: false }));
    await expect(resolve()).resolves.toEqual({ props: { session, refusal: 'no-checkpoint' } });
  });

  it('answers a run whose model was taken down as not found', async () => {
    mockGetWorkflow.mockResolvedValue(run('approved'));
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ workflowId: 'wf-1' }] as never);
    await expect(resolve()).resolves.toEqual({ props: { session, refusal: 'not-found' } });
  });

  it('explains a workflow that is not a training run', async () => {
    mockGetWorkflow.mockResolvedValue({ ...run('approved'), tags: ['generation'] });
    await expect(resolve()).resolves.toEqual({ props: { session, refusal: 'not-found' } });
  });

  it('still redirects a user who has not finished onboarding', async () => {
    mockGetWorkflow.mockResolvedValue(run('approved'));
    await expect(resolve({ user: { ...session.user, onboarding: 0 } })).resolves.toEqual({
      redirect: { destination: '/models', permanent: false },
    });
  });

  it('redirects a banned user before fetching an orchestrator token', async () => {
    mockGetWorkflow.mockResolvedValue(run('approved'));
    await expect(resolve({ user: { ...session.user, bannedAt: new Date() } })).resolves.toEqual({
      redirect: { destination: '/models', permanent: false },
    });
    expect(getOrchestratorToken).not.toHaveBeenCalled();
  });

  it('redirects when the orchestrator token is refused', async () => {
    vi.mocked(getOrchestratorToken).mockRejectedValueOnce(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(resolve()).resolves.toEqual({
      redirect: { destination: '/models', permanent: false },
    });
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });
});

describe('from-orchestrator SSR — adding the run as a new version', () => {
  const asVersion = (query: Record<string, string> = {}) =>
    resolve(session, { target: 'existing', ...query });

  beforeEach(() => {
    mockGetWorkflow.mockResolvedValue(run('approved'));
    dbMock.dbWrite.modelVersion.findFirst.mockResolvedValue(null as never);
  });

  it("lists the owner's eligible models, those on the run's base model first", async () => {
    dbMock.dbRead.model.findMany.mockResolvedValue([
      { id: 1, name: 'Flux one', meta: null, modelVersions: [{ baseModel: 'Flux.1 D' }] },
      { id: 2, name: 'Kept', meta: { removedWithOwner: true }, modelVersions: [] },
      { id: 3, name: 'SDXL one', meta: null, modelVersions: [{ baseModel: 'SDXL 1.0' }] },
    ] as never);
    const result = (await asVersion({ q: 'one' })) as {
      props: { pickModel: { query: string; models: { id: number }[]; baseQuery: object } };
    };
    expect(result.props.pickModel.query).toBe('one');
    expect(result.props.pickModel.models.map((m) => m.id)).toEqual([3, 1]);
    // Each model link is built off this, so the search term must not ride along.
    expect(result.props.pickModel.baseQuery).toEqual({
      workflowId: 'wf-1',
      epoch: '1',
      target: 'existing',
    });
    expect(dbMock.dbRead.model.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: session.user.id,
          name: { contains: 'one', mode: 'insensitive' },
        }),
      })
    );
  });

  it('sends a run that already has a draft back to it instead of offering a second one', async () => {
    dbMock.dbWrite.modelVersion.findFirst.mockResolvedValue({
      id: 61,
      meta: { trainingStudioWorkflowId: 'wf-1', trainingStudioModerationApproved: true },
      model: { id: 60, meta: null },
    } as never);
    await expect(asVersion()).resolves.toEqual({
      redirect: {
        destination:
          '/models/train/from-orchestrator?workflowId=wf-1&epoch=1&target=existing&modelId=60',
        permanent: false,
      },
    });
    expect(dbMock.dbRead.model.findMany).not.toHaveBeenCalled();
  });

  it('refuses the picker for an unapproved run', async () => {
    mockGetWorkflow.mockResolvedValue(run('underReview'));
    await expect(asVersion()).resolves.toEqual({ props: { session, refusal: 'not-approved' } });
  });

  it.each(['abc', '0', '-3'])('refuses a malformed model id %s', async (modelId) => {
    await expect(asVersion({ modelId })).resolves.toEqual({
      props: { session, refusal: 'model-not-eligible' },
    });
    // Refused before the run is read, so a malformed id never reaches a query.
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a model that is not one of the caller’s eligible models', async () => {
    dbMock.dbWrite.model.findFirst.mockResolvedValue(null);
    await expect(asVersion({ modelId: '60' })).resolves.toEqual({
      props: { session, refusal: 'model-not-eligible' },
    });
  });

  it('lands a resumed added version in the VERSION wizard, not the model wizard', async () => {
    mockGetWorkflow.mockResolvedValue(run('approved', { epochs: false }));
    dbMock.dbWrite.modelVersion.findFirst.mockResolvedValue({
      id: 61,
      meta: { trainingStudioWorkflowId: 'wf-1', trainingStudioModerationApproved: true },
      model: { id: 60, meta: null },
    } as never);
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({
      name: 'v2',
      baseModel: 'SDXL 1.0',
    } as never);
    dbMock.dbWrite.modelFile.findFirst.mockResolvedValue({ id: 9, metadata: null } as never);
    await expect(asVersion({ modelId: '60' })).resolves.toEqual({
      redirect: { destination: '/models/60/model-versions/61/wizard?step=2', permanent: false },
    });
  });
});
