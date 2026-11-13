import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The submit reply's resources are enriched for the SAME user the submit was validated for.
 *
 * A cold checkpoint covered only under the expansion rule is generatable by members and
 * moderators, refused to free users. `generateFromGraph` validated with the full user but used to
 * format its own reply with `{ id }` alone, so the reply told a paying member (and a moderator) the
 * checkpoint they had just been accepted on was `canGenerate: false`.
 *
 * `getResourceData` is faked, but its `canGenerate` comes from the real `coverageAudience` +
 * `coveredForUser`, so what the fake answers depends only on the user it is handed.
 */

vi.mock('@civitai/orchestration-client', async () =>
  (await import('./civitai-client.stub')).civitaiClientStub()
);

const { submitWorkflow } = vi.hoisted(() => ({
  submitWorkflow: vi.fn(async ({ body }: { body: Record<string, unknown> }) => ({
    // `<userId>-<timestamp>`: `assertWorkflowOwner` checks the prefix against the submitter.
    id: '1-20260101000000000',
    status: 'succeeded',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    steps: [],
    cost: { total: 60 },
    transactions: { list: [] },
    metadata: body.metadata,
  })),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow,
  deleteWorkflow: vi.fn(async () => undefined),
}));
vi.mock('~/server/orchestrator/orchestrator-identity-metrics', () => ({
  observeConsumerMismatch: vi.fn(),
  observeConsumerUnverifiable: vi.fn(),
}));

// The expansion rule on, open-to-all off: membership alone decides a cold checkpoint.
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClientMod>();
  return {
    ...actual,
    isFlipt: vi.fn(
      async (flag: string) => flag === actual.FLIPT_FEATURE_FLAGS.GENERATION_COVERAGE_NEXT
    ),
  };
});

vi.mock('~/server/services/generation/generation.service', async () => {
  const { coverageAudience, coveredForUser } = await import(
    '~/server/services/generation/coverage-source'
  );
  return {
    resolveTestingAccess: vi.fn(async () => false),
    getGateRules: vi.fn(async () => []),
    getSelfHostedDisabledEcosystems: vi.fn(() => [] as string[]),
    getResourceData: vi.fn(
      async (
        refs: { id: number }[],
        { user }: { user?: { id?: number; isModerator?: boolean; tier?: string } } = {}
      ) => {
        const { next, member } = await coverageAudience(user);
        const row = { covered: false, coveredNext: true, generatorLoaded: false };
        return refs.map(({ id }) => {
          const canGenerate = !!coveredForUser(row, next, { member, isCheckpoint: true });
          return {
            id,
            name: 'Cold community checkpoint',
            baseModel: 'Qwen',
            air: `urn:air:qwen:checkpoint:civitai:1@${id}`,
            model: { id: 1, name: 'Cold community checkpoint', type: 'Checkpoint', poi: false },
            availability: 'Public',
            ...row,
            canGenerate,
          };
        });
      }
    ),
  };
});

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
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createXGuardModerationRequest: vi.fn(async () => undefined),
}));

import type * as FliptClientMod from '~/server/flipt/client';
import { generateFromGraph } from '~/server/services/orchestrator/orchestration-new.service';
import { getWorkflowCapability } from '~/shared/generation/workflow-capability';

const CHECKPOINT_ID = getWorkflowCapability('Qwen', 'txt2img')?.defaultModelId as number;

function submit({ tier, isModerator }: { tier: string; isModerator: boolean }) {
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
      user: { isMember: tier !== 'free', tier },
      flags: {},
      selfHostedDisabledEcosystems: [],
      selfHostedMode: 'enabled',
      gateRules: [],
    },
    userId: 1,
    isModerator,
    token: 't',
    experimental: false,
  } as never);
}

function replyCanGenerate(reply: Awaited<ReturnType<typeof generateFromGraph>>) {
  const resource = reply.metadata?.resources.find((r) => r.id === CHECKPOINT_ID);
  return resource?.canGenerate;
}

beforeEach(() => {
  submitWorkflow.mockClear();
});

describe('generateFromGraph — the reply reads coverage for the submitting user', () => {
  it('🔴 a paying member is told the cold checkpoint they were accepted on is generatable', async () => {
    const reply = await submit({ tier: 'bronze', isModerator: false });
    expect(replyCanGenerate(reply)).toBe(true);
  });

  it('🔴 a moderator on the free tier is told the same', async () => {
    const reply = await submit({ tier: 'free', isModerator: true });
    expect(replyCanGenerate(reply)).toBe(true);
  });

  // Control: the fake is not always-true. A free user gets `canGenerate: false` from it, so
  // validation refuses the submit before anything reaches the orchestrator.
  it('a free user is refused the same checkpoint', async () => {
    await expect(submit({ tier: 'free', isModerator: false })).rejects.toThrow(
      'Some of your resources are not available for generation'
    );
    expect(submitWorkflow).not.toHaveBeenCalled();
  });
});
