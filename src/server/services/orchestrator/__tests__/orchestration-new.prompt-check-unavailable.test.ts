import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptCheckUnavailableError } from '~/server/services/orchestrator/prompt-check-unavailable';
import { TRPCError } from '@trpc/server';

/**
 * When the prompt check itself cannot run (its benign-phrase list read fails — a Redis or DB
 * outage), a prompted generation submit must fail CLOSED and gracefully: a 503 saying the prompt
 * check is temporarily unavailable, and no submit made.
 *
 * It used to land in the same catch as a moderation verdict. The error carried no `triggers` or
 * `blockedFor`, so building the "your prompt was flagged" message threw a TypeError — every
 * prompted submit became a 500 for as long as the outage lasted, and the logged error named the
 * TypeError, not the outage. Both message branches are exercised (`isGreen` takes a different one).
 *
 * The real `auditPromptServer` runs here; only the list read, the external classifier and the
 * orchestrator are faked. The harness mirrors `orchestration-new.submit-reply-coverage.test.ts`.
 */

vi.mock('@civitai/orchestration-client', async () =>
  (await import('./civitai-client.stub')).civitaiClientStub()
);

const { submitWorkflow, mockStripBenignPhrases } = vi.hoisted(() => ({
  mockStripBenignPhrases: vi.fn(),
  submitWorkflow: vi.fn(async ({ body }: { body: Record<string, unknown> }) => ({
    id: '1-20260101000000000',
    status: 'unassigned',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    steps: [],
    cost: { total: 60 },
    transactions: { list: [] },
    metadata: body.metadata,
  })),
}));

vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: mockStripBenignPhrases,
}));
vi.mock('~/server/integrations/moderation', () => ({
  extModeration: { moderatePrompt: vi.fn(async () => ({ flagged: false, categories: [] })) },
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow,
  deleteWorkflow: vi.fn(async () => undefined),
}));
vi.mock('~/server/orchestrator/orchestrator-identity-metrics', () => ({
  observeConsumerMismatch: vi.fn(),
  observeConsumerUnverifiable: vi.fn(),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  resolveTestingAccess: vi.fn(async () => false),
  getGateRules: vi.fn(async () => []),
  getSelfHostedDisabledEcosystems: vi.fn(() => [] as string[]),
  getResourceData: vi.fn(async (refs: { id: number }[]) =>
    refs.map(({ id }) => ({
      id,
      name: 'Checkpoint',
      baseModel: 'Qwen',
      air: `urn:air:qwen:checkpoint:civitai:1@${id}`,
      model: { id: 1, name: 'Checkpoint', type: 'Checkpoint', poi: false },
      availability: 'Public',
      covered: true,
      canGenerate: true,
    }))
  ),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/db/pgDb', () => ({ pgDbReadLong: {}, pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/db/datapacketDb', () => ({ datapacketDbRead: {}, datapacketDbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/search-index', () => ({}));
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
  imagesForModelVersionsCache: {},
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createXGuardModerationRequest: vi.fn(async () => undefined),
}));

import { generateFromGraph } from '~/server/services/orchestrator/orchestration-new.service';
import { getWorkflowCapability } from '~/shared/generation/workflow-capability';

const CHECKPOINT_ID = getWorkflowCapability('Qwen', 'txt2img')?.defaultModelId as number;

function submit({ isGreen }: { isGreen: boolean }) {
  return generateFromGraph({
    input: {
      workflow: 'txt2img',
      ecosystem: 'Qwen',
      model: { id: CHECKPOINT_ID },
      resources: [],
      prompt: 'a cat',
      sampler: 'Euler',
      steps: 25,
      quantity: 1,
      priority: 'low',
    },
    externalCtx: {
      limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
      user: { isMember: true, tier: 'bronze' },
      flags: {},
      selfHostedDisabledEcosystems: [],
      selfHostedMode: 'enabled',
      gateRules: [],
    },
    userId: 1,
    isModerator: false,
    isGreen,
    token: 't',
    experimental: false,
  } as never);
}

beforeEach(() => {
  submitWorkflow.mockClear();
  mockStripBenignPhrases.mockReset();
});

describe.each([{ isGreen: false }, { isGreen: true }])(
  'generateFromGraph — prompt check unavailable (isGreen: $isGreen)',
  ({ isGreen }) => {
    it('CONTROL: with the list readable, the prompt passes and the workflow is submitted', async () => {
      mockStripBenignPhrases.mockImplementation(async (text: string) => text);

      await submit({ isGreen });

      expect(mockStripBenignPhrases).toHaveBeenCalled();
      expect(submitWorkflow).toHaveBeenCalledTimes(1);
    });

    it('a failed list read is a 503, not a 500, and nothing is submitted', async () => {
      mockStripBenignPhrases.mockRejectedValue(
        new Error('Command timed out (redis cluster unreachable)')
      );

      const err = await submit({ isGreen }).then(
        () => undefined,
        (e: unknown) => e
      );

      expect(err).toBeInstanceOf(PromptCheckUnavailableError);
      expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
      expect((err as TRPCError).message).toMatch(/prompt check is temporarily unavailable/i);
      // Not reported as a moderation verdict.
      expect((err as TRPCError).message).not.toMatch(/flagged/i);
      // Fail closed: an unaudited prompt never reaches the orchestrator.
      expect(submitWorkflow).not.toHaveBeenCalled();
    });
  }
);
