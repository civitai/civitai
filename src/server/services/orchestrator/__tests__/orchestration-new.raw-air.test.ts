import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Raw orchestrator-blob AIR resources (training epochs without a ModelVersion
 * row) in `createWorkflowStepsFromGraph`.
 *
 * The load-bearing property is OWNERSHIP: a blob key is unguessable but that is
 * not authorization, so a raw AIR is accepted only when the accompanying
 * workflowId — fetched with the CALLER'S orchestrator token — contains an epoch
 * whose blob id matches the AIR's key. Every rejection case below is the revert
 * signal for one clause of that check; the accept case is the positive control
 * proving the path is reachable in this fixture (without it, each rejection
 * would also pass if the whole raw-AIR branch stopped running).
 *
 * The mock preamble mirrors `orchestration-new.poi-benign-phrases.test.ts`:
 * it keeps the heavy DB module graph inert so the module imports. The fixture
 * carries NO model, so `getResourceData` (mocked to `[]`) contributes nothing
 * and the raw-AIR validation is the first resource gate that can throw.
 */

const { mockGetWorkflow, mockGetHighestTierSubscription } = vi.hoisted(() => ({
  mockGetWorkflow: vi.fn(),
  mockGetHighestTierSubscription: vi.fn(),
}));

vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkflowsMod>()),
  getWorkflow: mockGetWorkflow,
}));
// Only the token-threading tests reach the audit (they enter through
// `generateFromGraph`); it is a redis/DB/external-moderation read this fixture
// cannot satisfy, and its verdict is irrelevant to what those tests pin.
vi.mock('~/server/services/orchestrator/promptAuditing', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptAuditingMod>()),
  auditPromptServer: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: (...args: unknown[]) => mockGetHighestTierSubscription(...args),
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
vi.mock('~/server/services/generation/generation.service', () => ({
  resolveTestingAccess: vi.fn(async () => false),
  getGateRules: vi.fn(async () => []),
  getSelfHostedDisabledEcosystems: vi.fn(() => [] as string[]),
  getResourceData: vi.fn(async () => []),
}));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
  imagesForModelVersionsCache: {},
}));

import type * as WorkflowsMod from '~/server/services/orchestrator/workflows';
import type * as PromptAuditingMod from '~/server/services/orchestrator/promptAuditing';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { resetHybridNodes } from '~/__tests__/mocks/hybrid';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import { getResourceData } from '~/server/services/generation/generation.service';
import {
  createWorkflowStepsFromGraph,
  formatGenerationResponse2,
  generateFromGraph,
  whatIfFromGraph,
} from '~/server/services/orchestrator/orchestration-new.service';

const USER_ID = 5;
const WORKFLOW_ID = `${USER_ID}-1700000000000`;
const BLOB_KEY = 'blobkey123';
const AIR = `urn:air:sdxl:lora:orchestrator:blob@${BLOB_KEY}`;
const TOKEN = 'caller-orchestrator-token';

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

/** AI-Toolkit shape: the epoch's blob id lives at `epochs[].model.id`. */
function workflowWithEpoch({
  completedAt,
  status = 'succeeded',
}: { completedAt?: string; status?: string } = {}) {
  return {
    steps: [
      {
        completedAt,
        status,
        output: { epochs: [{ epochNumber: 3, model: { id: BLOB_KEY, url: null } }] },
      },
    ],
  };
}

function rawAirResource(overrides?: Record<string, unknown>) {
  return {
    id: -42,
    model: { type: 'LORA' },
    strength: 0.8,
    air: AIR,
    workflowId: WORKFLOW_ID,
    name: 'my epoch',
    ...overrides,
  };
}

/** The error message this submission produced, or `''` when it produced none
 * before the raw-AIR gates (later step-assembly failures are irrelevant here —
 * the negative assertions match specific refusal messages, not "no error"). */
async function submit({
  resource = rawAirResource(),
  ecosystem = 'SDXL',
  noToken = false,
}: {
  resource?: Record<string, unknown>;
  ecosystem?: string;
  noToken?: boolean;
} = {}) {
  const error = await createWorkflowStepsFromGraph({
    data: { prompt: 'test', ecosystem, resources: [resource] } as never,
    user: { id: USER_ID, isModerator: false },
    orchestratorToken: noToken ? undefined : TOKEN,
  }).then(
    () => undefined,
    (e: unknown) => e
  );
  if (error === undefined) return '';
  return error instanceof Error ? error.message : String(error);
}

beforeEach(() => {
  // The ownership fetch is memoised through `fetchThroughCache`; resetting the
  // canonical redis mock between tests restores its cache-miss default so each
  // test's getWorkflow call-count assertions see only their own traffic.
  resetHybridNodes();
  // fetchThroughCache's stampede lock: the canonical redis mock has no default
  // for this command, and an `undefined` lock spins the 5s retry loop to
  // exhaustion instead of fetching.
  redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true);
  mockGetWorkflow.mockReset();
  mockGetHighestTierSubscription.mockReset();
  mockGetHighestTierSubscription.mockResolvedValue({ id: 'sub' });
  mockGetWorkflow.mockResolvedValue(workflowWithEpoch({ completedAt: daysAgo(1) }));
});

describe('raw-AIR resource ownership validation', () => {
  it('CONTROL: accepts a blob the caller-token workflow contains, fetching with that token', async () => {
    const message = await submit();

    expect(message).not.toMatch(/epoch resource/i);
    expect(mockGetWorkflow).toHaveBeenCalledTimes(1);
    expect(mockGetWorkflow).toHaveBeenCalledWith({
      token: TOKEN,
      path: { workflowId: WORKFLOW_ID },
    });
    // The derived ownership proof is cached under the CALLER'S id — the key
    // segment that keeps one user's cache entry from serving another's request.
    expect(redisMock.redis.packed.get).toHaveBeenCalledWith(
      `${REDIS_KEYS.CACHES.TRAINING_EPOCH_BLOBS}:${USER_ID}:${WORKFLOW_ID}`,
      expect.anything()
    );
  });

  it('accepts a legacy epoch matched via its blob URL', async () => {
    mockGetWorkflow.mockResolvedValue({
      steps: [
        {
          completedAt: daysAgo(1),
          status: 'succeeded',
          output: { epochs: [{ blobUrl: `https://x/v2/consumer/blobs/${BLOB_KEY}?q=1` }] },
        },
      ],
    });

    const message = await submit();
    expect(message).not.toMatch(/epoch resource/i);
    expect(message).not.toMatch(/has expired/);
  });

  it('rejects a blob the referenced workflow does NOT contain', async () => {
    mockGetWorkflow.mockResolvedValue({
      steps: [{ output: { epochs: [{ epochNumber: 1, model: { id: 'some-other-blob' } }] } }],
    });

    expect(await submit()).toMatch(/does not belong to the referenced training workflow/);
  });

  it('rejects a raw AIR without a workflowId', async () => {
    expect(await submit({ resource: rawAirResource({ workflowId: undefined }) })).toMatch(
      /must reference the training workflow/
    );
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('rejects a workflowId whose owner prefix names another user, without fetching', async () => {
    expect(await submit({ resource: rawAirResource({ workflowId: '999-1700000000000' }) })).toMatch(
      /do not have access/
    );
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('rejects when the path has no orchestrator token (e.g. the App Blocks bridge)', async () => {
    expect(await submit({ noToken: true })).toMatch(/not supported on this generation path/);
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('rejects an AIR whose ecosystem family differs from the request ecosystem', async () => {
    expect(await submit({ ecosystem: 'Flux1' })).toMatch(/not compatible with the selected/);
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('accepts a CHILD ecosystem request in the same family as the AIR (Pony → sdxl)', async () => {
    expect(await submit({ ecosystem: 'Pony' })).not.toMatch(/epoch resource/i);
  });

  it('rejects an AIR naming an unknown ecosystem', async () => {
    expect(
      await submit({
        resource: rawAirResource({ air: `urn:air:notaneco:lora:orchestrator:blob@${BLOB_KEY}` }),
      })
    ).toMatch(/unknown ecosystem/);
  });

  it('rejects a non-blob orchestrator AIR (an epoch jobId AIR is not a raw blob)', async () => {
    expect(
      await submit({
        resource: rawAirResource({
          air: 'urn:air:sdxl:lora:orchestrator:somejob@file.safetensors',
        }),
      })
    ).toMatch(/Invalid epoch resource/);
  });

  it('applies the epoch subscription gate to raw AIRs', async () => {
    mockGetHighestTierSubscription.mockResolvedValue(null);

    expect(await submit()).toMatch(/require an active subscription/);
  });
});

describe('epoch generation window (15-day parity with ModelVersion epochs)', () => {
  it('accepts an epoch whose training completed inside the window', async () => {
    mockGetWorkflow.mockResolvedValue(workflowWithEpoch({ completedAt: daysAgo(14) }));

    const message = await submit();

    expect(message).not.toMatch(/has expired/);
    expect(message).not.toMatch(/epoch resource/i);
  });

  it('rejects an epoch past the window with the same message as the ModelVersion path', async () => {
    mockGetWorkflow.mockResolvedValue(workflowWithEpoch({ completedAt: daysAgo(16) }));

    expect(await submit()).toMatch(/has expired\. Make it a private model to continue using it\./);
  });

  it('accepts an epoch from a training that has not completed yet', async () => {
    // A still-RUNNING step reports no completion date; its window has not
    // started, so mid-training epochs stay generatable.
    mockGetWorkflow.mockResolvedValue(
      workflowWithEpoch({ completedAt: undefined, status: 'processing' })
    );

    const message = await submit();
    expect(message).not.toMatch(/has expired/);
    expect(message).not.toMatch(/epoch resource/i);
  });

  it('rejects an epoch from a TERMINAL step with no completion date (canceled run)', async () => {
    // Canceling a run after its last saved epoch leaves completedAt null; a
    // null date must not read as "window never started" there, or the epoch
    // stays generatable forever.
    mockGetWorkflow.mockResolvedValue(
      workflowWithEpoch({ completedAt: undefined, status: 'canceled' })
    );

    expect(await submit()).toMatch(/has expired\. Make it a private model to continue using it\./);
  });

  it('rejects a null completion date when the step status is missing entirely', async () => {
    // Fail closed: a real orchestrator step always carries a status, and a
    // legitimately completed run always has completedAt.
    mockGetWorkflow.mockResolvedValue({
      steps: [{ output: { epochs: [{ epochNumber: 3, model: { id: BLOB_KEY, url: null } }] } }],
    });

    expect(await submit()).toMatch(/has expired/);
  });
});

describe('ownership-fetch caching', () => {
  it('serves a cached derivation without refetching the workflow', async () => {
    redisMock.redis.packed.get.mockResolvedValue({
      data: { blobKeys: [BLOB_KEY], completedAt: daysAgo(1), stepStatus: 'succeeded' },
      cachedAt: Date.now(),
    });

    const message = await submit();

    expect(message).not.toMatch(/epoch resource/i);
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('a cached derivation still enforces the expiry window', async () => {
    redisMock.redis.packed.get.mockResolvedValue({
      data: { blobKeys: [BLOB_KEY], completedAt: daysAgo(16), stepStatus: 'succeeded' },
      cachedAt: Date.now(),
    });

    expect(await submit()).toMatch(/has expired/);
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });
});

/**
 * Pins the `orchestratorToken: token` threading in `generateFromGraph` and
 * `whatIfFromGraph` — the service-boundary callers of
 * `createWorkflowStepsFromGraph`. Deleting either threading line makes the
 * raw-AIR validation reject with "not supported on this generation path"
 * before `getWorkflow` is ever reached, so the assertion below goes red.
 * The submissions themselves die later in step assembly (the shared
 * `@civitai/client` mock has no TimeSpan constructor) — irrelevant here.
 */
describe('orchestratorToken threading at the service boundary', () => {
  const externalCtx = (): GenerationCtx => ({
    limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
    user: { isMember: true, tier: 'bronze' },
    flags: {},
    selfHostedDisabledEcosystems: [],
    selfHostedMode: 'enabled',
    gateRules: [],
  });
  const graphInput = () => ({
    workflow: 'txt2img',
    ecosystem: 'SDXL',
    model: { id: 128078 },
    resources: [rawAirResource()],
    prompt: 'a cat',
    sampler: 'Euler',
    steps: 25,
    quantity: 1,
    priority: 'low',
  });

  it('generateFromGraph hands its token to the raw-AIR ownership fetch', async () => {
    await generateFromGraph({
      input: graphInput(),
      externalCtx: externalCtx(),
      token: TOKEN,
      userId: USER_ID,
      isModerator: false,
    }).catch(() => undefined);

    expect(mockGetWorkflow).toHaveBeenCalledWith({
      token: TOKEN,
      path: { workflowId: WORKFLOW_ID },
    });
  });

  it('whatIfFromGraph hands its token to the raw-AIR ownership fetch', async () => {
    await whatIfFromGraph({
      input: graphInput(),
      externalCtx: externalCtx(),
      token: TOKEN,
      userId: USER_ID,
      isModerator: false,
    }).catch(() => undefined);

    expect(mockGetWorkflow).toHaveBeenCalledWith({
      token: TOKEN,
      path: { workflowId: WORKFLOW_ID },
    });
  });
});

/**
 * Read path: `formatGenerationResponse2` hydrates every stored resource via
 * `getResourceData` (a ModelVersion lookup), which cannot resolve a raw-AIR
 * entry's synthetic negative id. Before the fix the entry was silently dropped
 * from the queue item's resource list; now it is rebuilt from its stored
 * fields. `getResourceData` is mocked to `[]`, so anything surviving in the
 * output can only have come from the raw-AIR pass-through.
 */
describe('read path: formatGenerationResponse2 keeps raw-AIR resources', () => {
  const storedWorkflow = () =>
    ({
      id: 'wf-read-1',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      metadata: {
        params: { prompt: 'test', ecosystem: 'SDXL', workflow: 'txt2img' },
        resources: [
          rawAirResource({ baseModel: 'SDXL 1.0' }),
          { id: 999, model: { type: 'LORA' }, strength: 1 },
        ],
      },
      steps: [],
    } as never);

  it('surfaces the stored epoch as a self-contained resource with its name, air and workflowId', async () => {
    const [formatted] = await formatGenerationResponse2([storedWorkflow()]);

    const epoch = formatted.metadata?.resources?.find((r) => r.id === -42);
    expect(epoch).toMatchObject({
      id: -42,
      name: 'my epoch',
      air: AIR,
      strength: 0.8,
      baseModel: 'SDXL 1.0',
      model: { id: -42, name: 'my epoch', type: 'LORA' },
    });
    // Remix needs the ownership proof to survive the round-trip.
    expect((epoch as { workflowId?: string } | undefined)?.workflowId).toBe(WORKFLOW_ID);
  });

  it('does not ask getResourceData to hydrate the synthetic negative id', async () => {
    vi.mocked(getResourceData).mockClear();

    await formatGenerationResponse2([storedWorkflow()]);

    const calls = vi.mocked(getResourceData).mock.calls;
    expect(calls).toHaveLength(1);
    expect((calls[0][0] as Array<{ id: number }>).map((r) => r.id)).toEqual([999]);
  });
});
