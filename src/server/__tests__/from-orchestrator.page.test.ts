import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Workflows from '~/server/services/orchestrator/workflows';

/**
 * The from-orchestrator page's server side: a run whose dataset is not approved renders the
 * explanation instead of being bounced to /models, while every other refusal keeps the redirect.
 * `createDraftModelFromWorkflow` and its moderation check run for real; the session wrapper,
 * the orchestrator read and the DB are faked.
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

import type { Workflow } from '@civitai/client';
import { OnboardingSteps } from '~/server/common/enums';
import { getServerSideProps } from '~/pages/models/train/from-orchestrator';
import { dbMock } from '~/__tests__/mocks/db.mock';

const session = { user: { id: 5, muted: false, onboarding: OnboardingSteps.Buzz } };

function run(moderationStatus: string | undefined, epochs = true): Workflow {
  return {
    id: 'wf-1',
    tags: ['training'],
    steps: [
      {
        $type: 'training',
        input: { ecosystem: 'sdxl' },
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

const resolve = () =>
  (getServerSideProps as unknown as (args: unknown) => Promise<unknown>)({
    session,
    ctx: { query: { workflowId: 'wf-1', epoch: '1' }, resolvedUrl: '/x', req: {}, res: {} },
  });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.model.findFirst.mockResolvedValue(null);
});

describe('from-orchestrator SSR — training moderation refusal', () => {
  it.each(['evaluating', 'underReview', 'rejected', undefined])(
    'renders the explanation for a run whose status is %s',
    async (status) => {
      mockGetWorkflow.mockResolvedValue(run(status));
      await expect(resolve()).resolves.toEqual({ props: { session, refusal: 'not-approved' } });
    }
  );

  it('keeps redirecting to /models for any other refusal (no downloadable checkpoint)', async () => {
    mockGetWorkflow.mockResolvedValue(run('approved', false));
    await expect(resolve()).resolves.toEqual({
      redirect: { destination: '/models', permanent: false },
    });
  });
});
