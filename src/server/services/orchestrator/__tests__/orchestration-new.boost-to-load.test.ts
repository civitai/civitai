import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Boost-to-load: a free account may load a cold expansion checkpoint by paying for a Download
 * Boost, when the generator opts in and `generation-loading-boost-for-free` is on.
 *
 * `getResourceData` is faked, but its `canGenerate` and `boostRequired` come from the real
 * `coverageAudience` + `coveredForUser` + `boostRequiredFor`, so they depend only on the user, the
 * opt-in and whether the row is resident. The whatIf reply is set per test.
 */

vi.mock('@civitai/orchestration-client', async () =>
  (await import('./civitai-client.stub')).civitaiClientStub()
);

const state = vi.hoisted(() => ({
  resident: false,
  whatIfLane: 'high' as string | undefined,
  whatIfPreparation: true,
  whatIfFails: false,
  whatIfFee: 100 as number | undefined,
}));

const { submitWorkflow } = vi.hoisted(() => ({
  submitWorkflow: vi.fn(
    async ({ body, query }: { body: Record<string, unknown>; query?: { whatif?: boolean } }) => {
      if (query?.whatif) {
        if (state.whatIfFails) throw new Error('orchestrator down');
        return {
          downloadPriority: state.whatIfLane,
          cost: { total: 160, fixed: { downloadPriority: state.whatIfFee } },
          steps: [
            {
              name: '0',
              preparation: state.whatIfPreparation
                ? [
                    {
                      resource: 'urn:air:qwen:checkpoint:civitai:1@2',
                      sizeBytes: 6e9,
                      lane: 'high',
                    },
                  ]
                : undefined,
            },
          ],
        };
      }
      return {
        // `<userId>-<timestamp>`: `assertWorkflowOwner` checks the prefix against the submitter.
        id: '1-20260101000000000',
        status: 'succeeded',
        createdAt: new Date('2020-01-01T00:00:00Z'),
        steps: [],
        cost: { total: 60 },
        transactions: { list: [] },
        metadata: body.metadata,
        downloadPriority: body.downloadPriority,
      };
    }
  ),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow,
  deleteWorkflow: vi.fn(async () => undefined),
}));
vi.mock('~/server/orchestrator/orchestrator-identity-metrics', () => ({
  observeConsumerMismatch: vi.fn(),
  observeConsumerUnverifiable: vi.fn(),
}));

const flags = vi.hoisted(() => ({ boostForFree: true }));
// The expansion rule on, open-to-all off; boost-for-free per test.
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClientMod>();
  return {
    ...actual,
    isFlipt: vi.fn(
      async (flag: string) =>
        flag === actual.FLIPT_FEATURE_FLAGS.GENERATION_COVERAGE_NEXT ||
        (flag === actual.FLIPT_FEATURE_FLAGS.GENERATION_LOADING_BOOST_FOR_FREE &&
          flags.boostForFree)
    ),
  };
});

vi.mock('~/server/services/generation/generation.service', async () => {
  const { coverageAudience, coveredForUser, boostRequiredFor } = await import(
    '~/server/services/generation/coverage-source'
  );
  return {
    resolveTestingAccess: vi.fn(async () => false),
    getGateRules: vi.fn(async () => []),
    getSelfHostedDisabledEcosystems: vi.fn(() => [] as string[]),
    getResourceData: vi.fn(
      async (
        refs: { id: number }[],
        {
          user,
          acceptBoostRequired,
        }: {
          user?: { id?: number; isModerator?: boolean; tier?: string };
          acceptBoostRequired?: boolean;
        } = {}
      ) => {
        const { next, member, boostAdmits } = await coverageAudience(user, {
          acceptBoostRequired,
        });
        const row = { covered: false, coveredNext: true, generatorLoaded: state.resident };
        const audience = { member, isCheckpoint: true, boostAdmits };
        return refs.map(({ id }) => ({
          id,
          name: 'Cold community checkpoint',
          baseModel: 'Qwen',
          air: `urn:air:qwen:checkpoint:civitai:1@${id}`,
          model: { id: 1, name: 'Cold community checkpoint', type: 'Checkpoint', poi: false },
          availability: 'Public',
          ...row,
          canGenerate: !!coveredForUser(row, next, audience),
          ...(boostRequiredFor(row, next, audience) ? { boostRequired: true } : {}),
        }));
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
import {
  generateFromGraph,
  whatIfFromGraph,
} from '~/server/services/orchestrator/orchestration-new.service';
import { getWorkflowCapability } from '~/shared/generation/workflow-capability';

const CHECKPOINT_ID = getWorkflowCapability('Qwen', 'txt2img')?.defaultModelId as number;

function submit({
  tier = 'free',
  acceptBoostRequired = true,
  boost = true,
}: {
  tier?: string;
  acceptBoostRequired?: boolean;
  boost?: boolean;
} = {}) {
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
    isModerator: false,
    token: 't',
    experimental: false,
    acceptBoostRequired,
    downloadPriority: boost ? 'high' : undefined,
  } as never);
}

const realSubmits = () =>
  submitWorkflow.mock.calls.filter(([{ query }]) => !(query as { whatif?: boolean })?.whatif);
const whatIfs = () =>
  submitWorkflow.mock.calls.filter(([{ query }]) => (query as { whatif?: boolean })?.whatif);
const submittedBody = () => realSubmits()[0]?.[0].body as Record<string, unknown>;

beforeEach(() => {
  submitWorkflow.mockClear();
  Object.assign(state, {
    resident: false,
    whatIfLane: 'high',
    whatIfPreparation: true,
    whatIfFails: false,
    whatIfFee: 100,
  });
  flags.boostForFree = true;
});

describe('generateFromGraph — boost-to-load for a free account', () => {
  it('sends a boosted free submit on the paid tier in the high lane, once', async () => {
    await submit();
    expect(realSubmits()).toHaveLength(1);
    expect(submittedBody()).toMatchObject({ tier: 'paid', downloadPriority: 'high' });
    // The price it was checked against was asked for the same way.
    expect(whatIfs()[0][0].body).toMatchObject({ tier: 'paid', downloadPriority: 'high' });
  });

  // The reply re-reads the resources: without the opt-in it would mark the admitted checkpoint
  // `canGenerate: false` in the queue the user just paid to join.
  it('formats the reply with the same opt-in, so the admitted checkpoint stays generatable', async () => {
    const { getResourceData } = await import('~/server/services/generation/generation.service');
    await submit();
    const replyRead = vi.mocked(getResourceData).mock.calls.at(-1)?.[1];
    expect(replyRead).toMatchObject({ acceptBoostRequired: true });
  });

  // Control: without the opt-in the members gate is untouched, which is every non-generator caller.
  it('still refuses a free account that did not opt in', async () => {
    await expect(submit({ acceptBoostRequired: false })).rejects.toThrow(
      'not available for generation'
    );
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('still refuses a free account while the flag is off', async () => {
    flags.boostForFree = false;
    await expect(submit()).rejects.toThrow('not available for generation');
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses an opted-in free submit that does not ask for the boost', async () => {
    await expect(submit({ boost: false })).rejects.toThrow('Free accounts need to boost');
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses, unsent, when the orchestrator prices it outside the high lane', async () => {
    state.whatIfLane = 'low';
    await expect(submit()).rejects.toThrow("download boost couldn't be confirmed");
    expect(realSubmits()).toHaveLength(0);
  });

  it('refuses, unsent, when the price check fails', async () => {
    state.whatIfFails = true;
    await expect(submit()).rejects.toThrow("download boost couldn't be confirmed");
    expect(realSubmits()).toHaveLength(0);
  });

  it('refuses, unsent, when the high-lane whatIf carries no boost fee', async () => {
    state.whatIfFee = undefined;
    await expect(submit()).rejects.toThrow("download boost couldn't be confirmed");
    expect(realSubmits()).toHaveLength(0);
  });

  it('refuses, unsent, when the high-lane whatIf prices the boost at zero', async () => {
    state.whatIfFee = 0;
    await expect(submit()).rejects.toThrow("download boost couldn't be confirmed");
    expect(realSubmits()).toHaveLength(0);
  });

  // Sent unboosted, a model evicted after this whatIf would load free for a non-member.
  it('refuses, unsent, when the whatIf shows nothing to download', async () => {
    state.whatIfPreparation = false;
    await expect(submit()).rejects.toThrow("download boost couldn't be confirmed");
    expect(realSubmits()).toHaveLength(0);
  });
});

/**
 * 🔴 DECISION: `tier: 'paid'` is pinned on boost-to-load submits ONLY. The orchestrator forces a
 * free-tier workflow into the free lane, which a boost cannot leave; every other submit leaves the
 * tier for the orchestrator to derive. Before widening the pin to every boosted submit, or dropping
 * it as redundant, ask the backend lead: both change what a free account is charged.
 */
describe('the tier pin is for boost-to-load submits only', () => {
  it('sends no tier for a free account on a resident model', async () => {
    state.resident = true;
    await submit();
    expect(realSubmits()).toHaveLength(1);
    expect(submittedBody()).not.toHaveProperty('tier');
  });

  it('sends no tier for a member boosting the same cold model', async () => {
    await submit({ tier: 'bronze' });
    expect(realSubmits()).toHaveLength(1);
    expect(submittedBody()).toMatchObject({ downloadPriority: 'high' });
    expect(submittedBody()).not.toHaveProperty('tier');
    expect(whatIfs()[0][0].body).not.toHaveProperty('tier');
  });
});

function price({ tier = 'free', boost = false }: { tier?: string; boost?: boolean } = {}) {
  return whatIfFromGraph({
    input: {
      workflow: 'txt2img',
      ecosystem: 'Qwen',
      model: { id: CHECKPOINT_ID },
      resources: [],
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
    isModerator: false,
    token: 't',
    experimental: false,
    acceptBoostRequired: true,
    downloadPriority: boost ? 'high' : undefined,
  } as never);
}

describe('whatIfFromGraph — the price the generator shows', () => {
  it('tells the generator a free account must boost, instead of refusing', async () => {
    await expect(price()).resolves.toMatchObject({ boostRequired: true });
  });

  // The fee on screen comes from this reply; without the tier it would be the free lane's.
  it('prices the boost on the paid tier, as the submit will send it', async () => {
    await price({ boost: true });
    expect(whatIfs()[0][0].body).toMatchObject({ tier: 'paid', downloadPriority: 'high' });
  });

  it('leaves the unboosted price and every member price without a tier', async () => {
    await price();
    await price({ tier: 'bronze', boost: true });
    expect(whatIfs().map(([{ body }]) => body)).not.toContainEqual(
      expect.objectContaining({ tier: expect.anything() })
    );
  });

  it('says nothing for a member', async () => {
    await expect(price({ tier: 'bronze' })).resolves.not.toHaveProperty('boostRequired');
  });
});
