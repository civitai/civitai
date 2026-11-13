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
}));

vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(async () => 'token'),
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  updateWorkflow: h.updateWorkflow,
  getWorkflow: h.getWorkflow,
  patchWorkflows: h.patchWorkflows,
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

  it('refuses an unlock for a user with mature content off', async () => {
    const error = await errorOf(caller({ domain: 'red', showNsfw: false }).updateWorkflow(unlock));
    expect(error).toEqual({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/account settings/),
    });
    expect(h.getWorkflow).not.toHaveBeenCalled();
    expect(h.updateWorkflow).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: unlocks on red with mature content on', async () => {
    await caller({ domain: 'red', showNsfw: true }).updateWorkflow(unlock);
    expect(h.updateWorkflow).toHaveBeenCalledTimes(1);
  });

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
