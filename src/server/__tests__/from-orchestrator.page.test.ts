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

const resolve = (s: unknown = session) =>
  (getServerSideProps as unknown as (args: unknown) => Promise<unknown>)({
    session: s,
    ctx: { query: { workflowId: 'wf-1', epoch: '1' }, resolvedUrl: '/x', req: {}, res: {} },
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
});
