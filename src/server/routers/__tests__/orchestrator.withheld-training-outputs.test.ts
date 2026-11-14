import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Workflows from '~/server/services/orchestrator/workflows';

// 🔴 Do NOT mock `~/env/server` here — see `deprecated-rewards.gate.test.ts`.

const h = vi.hoisted(() => ({
  getWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  updateWorkflow: vi.fn(),
  withheld: vi.fn(async (_userId: number, _ids: string[]) => [] as string[]),
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: h.getWorkflow,
  queryWorkflows: h.queryWorkflows,
  updateWorkflow: h.updateWorkflow,
}));
vi.mock('~/server/services/orchestrator/training/studio-withheld', () => ({
  studioWithheldWorkflowIds: h.withheld,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(async () => 'token'),
}));

import { OnboardingSteps } from '~/server/common/enums';
import { orchestratorRouter } from '~/server/routers/orchestrator.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const caller = (isModerator = false) =>
  orchestratorRouter.createCaller({
    user: {
      id: 7,
      isModerator,
      onboarding: OnboardingSteps.Buzz,
      emailVerified: new Date('2020-01-01'),
      muted: false,
      bannedAt: null,
      showNsfw: false,
    },
    ip: '1.2.3.4',
    features: {},
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
  } as never);

const MARK = 'epoch-marker';
const run = (id: string, $type = 'training') => ({
  id,
  tags: ['civitai', 'training'],
  steps: [
    {
      $type,
      name: 'train',
      status: 'succeeded',
      input: { ecosystem: 'sdxl', continueFrom: `urn:air:sdxl:lora:orchestrator:blob@${MARK}` },
      metadata: { copied: { epochs: [{ model: { url: `https://x/m?${MARK}` } }] } },
      output: { epochs: [{ epochNumber: 1, model: { url: `https://x/m?${MARK}` } }] },
    },
  ],
});
const generation = {
  id: 'gen-1',
  tags: ['civitai', 'gen'],
  steps: [{ $type: 'imageGen', output: { images: [] } }],
};

beforeEach(() => {
  h.withheld.mockReset().mockResolvedValue(['wf-1']);
  h.getWorkflow.mockReset().mockResolvedValue(run('wf-1'));
  h.queryWorkflows.mockReset().mockResolvedValue({ items: [run('wf-1'), run('wf-2'), generation] });
});

describe('orchestrator.getWorkflow on a withheld training run', () => {
  it.each(['training', 'imageResourceTraining'])(
    'returns a %s run with nothing but its step type, name and status',
    async ($type) => {
      h.getWorkflow.mockResolvedValue(run('wf-1', $type));
      const wf = await caller().getWorkflow({ workflowId: 'wf-1' });
      expect(JSON.stringify(wf)).not.toContain(MARK);
      expect(wf).toMatchObject({
        id: 'wf-1',
        steps: [{ $type, name: 'train', status: 'succeeded' }],
      });
      expect(h.withheld).toHaveBeenCalledWith(7, ['wf-1']);
    }
  );

  it('fails closed when the withheld lookup fails', async () => {
    h.withheld.mockRejectedValue(new Error('db down'));
    await expect(caller().getWorkflow({ workflowId: 'wf-1' })).rejects.toBeTruthy();
  });

  it('returns everything to a moderator', async () => {
    expect(JSON.stringify(await caller(true).getWorkflow({ workflowId: 'wf-1' }))).toContain(MARK);
    expect(h.withheld).not.toHaveBeenCalled();
  });
});

describe('orchestrator.queryWorkflowsByTags', () => {
  it('clears only the withheld runs, asking once for the training runs', async () => {
    const { items } = await caller().queryWorkflowsByTags({ tags: ['training'] } as never);
    expect(h.withheld).toHaveBeenCalledTimes(1);
    expect(h.withheld).toHaveBeenCalledWith(7, ['wf-1', 'wf-2']);
    expect(JSON.stringify(items[0])).not.toContain(MARK);
    expect(JSON.stringify(items[1])).toContain(MARK);
    expect(items[2]).toEqual(generation);
  });
});

// Not gated: this mutation answers with the formatted generation view, which carries nothing of a
// training step. Pinned so a change to that formatter cannot start leaking a withheld run.
describe('orchestrator.updateWorkflow on a training run', () => {
  it('answers without any training-step input, output or metadata', async () => {
    h.updateWorkflow.mockResolvedValue(run('wf-1'));
    const result = await caller().updateWorkflow({ workflowId: 'wf-1' });
    expect(result).toMatchObject({ id: 'wf-1' });
    expect(JSON.stringify(result)).not.toContain(MARK);
  });
});
