import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Workflows from '~/server/services/orchestrator/workflows';

// 🔴 Do NOT mock `~/env/server` here — see `deprecated-rewards.gate.test.ts` for why importing
// `orchestrator.router` relies on the canonical env mock.

const h = vi.hoisted(() => ({
  updateWorkflow: vi.fn(async () => ({ id: '5-1', steps: [] })),
  getWorkflow: vi.fn(async () => ({
    id: '5-1',
    allowMatureContent: false,
    steps: [{ $type: 'imageGen', name: '$0', output: { images: [{ id: '1', nsfwLevel: 'x' }] } }],
  })),
  patchWorkflows: vi.fn(async () => undefined),
  queryWorkflows: vi.fn(async (_query: { hideMatureContent: boolean }) => ({ items: [] })),
}));

vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(async () => 'token'),
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  updateWorkflow: h.updateWorkflow,
  getWorkflow: h.getWorkflow,
  patchWorkflows: h.patchWorkflows,
  queryWorkflows: h.queryWorkflows,
}));

import { orchestratorRouter } from '~/server/routers/orchestrator.router';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const caller = ({ domain, showNsfw }: { domain: 'green' | 'red'; showNsfw: boolean }) =>
  orchestratorRouter.createCaller({
    user: {
      id: 7,
      onboarding: OnboardingSteps.Buzz,
      emailVerified: new Date('2020-01-01'),
      muted: false,
      bannedAt: null,
      showNsfw,
    },
    domain,
    ip: '1.2.3.4',
    features: {},
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
  } as never);

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message })
  );

const unlock = { workflowId: '5-1', allowMatureContent: true };

describe('orchestrator mature unlock refusal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses an unlock on the green domain', async () => {
    const error = await errorOf(caller({ domain: 'green', showNsfw: true }).updateWorkflow(unlock));
    expect(error).toEqual({ code: 'BAD_REQUEST', message: expect.stringMatching(/civitai\.red/) });
    expect(h.getWorkflow).not.toHaveBeenCalled();
    expect(h.updateWorkflow).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'unlocks on red whatever the mature content setting (%s)',
    async (showNsfw) => {
      await caller({ domain: 'red', showNsfw }).updateWorkflow(unlock);
      expect(h.updateWorkflow).toHaveBeenCalledTimes(1);
    }
  );

  it('refuses a workflow patch that sets allowMatureContent', async () => {
    const error = await errorOf(
      caller({ domain: 'red', showNsfw: true }).patch({
        workflows: [
          {
            workflowId: '5-1',
            patches: [{ op: 'replace', path: '/allowMatureContent', value: true }],
          },
        ],
      })
    );
    expect(error?.code).toBe('BAD_REQUEST');
    expect(h.patchWorkflows).not.toHaveBeenCalled();
  });
});

describe('orchestrator reads: mature content follows the domain, not the setting', () => {
  beforeEach(() => vi.clearAllMocks());

  const hidesMature = async (domain: 'green' | 'red', showNsfw: boolean) => {
    await caller({ domain, showNsfw }).queryWorkflowsByTags({});
    return h.queryWorkflows.mock.calls[0][0].hideMatureContent;
  };

  it('hides mature outputs on green', async () => {
    expect(await hidesMature('green', true)).toBe(true);
  });

  it.each([true, false])('shows them on red whatever the setting (%s)', async (showNsfw) => {
    expect(await hidesMature('red', showNsfw)).toBe(false);
  });
});
