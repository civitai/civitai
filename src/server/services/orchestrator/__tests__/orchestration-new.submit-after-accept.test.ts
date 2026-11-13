import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `generateFromGraph` does AROUND the paid submit, where a failure costs the user money.
 *
 * 1. Every submit carries an idempotency key. The form mints one per click, but an API caller may
 *    send none, and without one a retried submit (the wrapper retries 5xx and timeouts) can create
 *    a second workflow — a second charge for one request.
 * 2. Once the orchestrator has ACCEPTED the workflow (and charged for it), a failure in the
 *    reply's enrichment (a resource lookup against the DB / cache) must not turn into a 500. A 500
 *    there tells the user nothing was submitted, and the obvious response — clicking Generate
 *    again — is a second charge. The reply falls back to the workflow without enrichment; the
 *    queue's own poll fills the rest in.
 *
 * The harness mirrors `orchestration-new.submit-reply-coverage.test.ts`.
 */

vi.mock('@civitai/orchestration-client', async () =>
  (await import('./civitai-client.stub')).civitaiClientStub()
);

const WORKFLOW_ID = '1-20260101000000000';

const { submitWorkflow, state } = vi.hoisted(() => {
  const state = { accepted: false, failEnrichmentAfterAccept: false };
  return {
    state,
    submitWorkflow: vi.fn(async ({ body }: { body: Record<string, unknown> }) => {
      state.accepted = true;
      return {
        // `<userId>-<timestamp>`: `assertWorkflowOwner` checks the prefix against the submitter.
        id: '1-20260101000000000',
        status: 'unassigned',
        createdAt: new Date('2020-01-01T00:00:00Z'),
        steps: [],
        cost: { total: 60 },
        transactions: { list: [] },
        metadata: body.metadata,
      };
    }),
  };
});
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
  getResourceData: vi.fn(async (refs: { id: number }[]) => {
    if (state.accepted && state.failEnrichmentAfterAccept)
      throw new Error('Connection terminated due to connection timeout');
    return refs.map(({ id }) => ({
      id,
      name: 'Checkpoint',
      baseModel: 'Qwen',
      air: `urn:air:qwen:checkpoint:civitai:1@${id}`,
      model: { id: 1, name: 'Checkpoint', type: 'Checkpoint', poi: false },
      availability: 'Public',
      covered: true,
      canGenerate: true,
    }));
  }),
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
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createXGuardModerationRequest: vi.fn(async () => undefined),
}));

import { generateFromGraph } from '~/server/services/orchestrator/orchestration-new.service';
import { getWorkflowCapability } from '~/shared/generation/workflow-capability';

const CHECKPOINT_ID = getWorkflowCapability('Qwen', 'txt2img')?.defaultModelId as number;

function submit({ externalId }: { externalId?: string } = {}) {
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
    token: 't',
    experimental: false,
    externalId,
  } as never);
}

const sentExternalIds = () =>
  submitWorkflow.mock.calls.map((c) => (c[0] as { body: { externalId?: string } }).body.externalId);

beforeEach(() => {
  submitWorkflow.mockClear();
  state.accepted = false;
  state.failEnrichmentAfterAccept = false;
});

describe('generateFromGraph — the idempotency key', () => {
  it('mints one when the caller sends none, and a different one per submit', async () => {
    await submit();
    await submit();

    const [first, second] = sentExternalIds();
    expect(typeof first).toBe('string');
    expect(first?.length).toBeGreaterThan(0);
    expect(second).not.toBe(first);
  });

  it("forwards the caller's own key unchanged", async () => {
    await submit({ externalId: 'client-key-123' });

    expect(sentExternalIds()).toEqual(['client-key-123']);
  });
});

describe('generateFromGraph — a failure after the orchestrator accepted', () => {
  it('CONTROL: the enrichment lookup is reached after the submit and its data is in the reply', async () => {
    const reply = await submit();

    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    expect(reply.metadata?.resources.some((r) => r.id === CHECKPOINT_ID)).toBe(true);
  });

  it('returns the accepted workflow instead of a 500 when enrichment throws', async () => {
    state.failEnrichmentAfterAccept = true;

    const reply = await submit();

    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    expect(reply.id).toBe(WORKFLOW_ID);
    // Success-shaped: the queue card can be built from it (steps array present).
    expect(Array.isArray(reply.steps)).toBe(true);
  });
});
