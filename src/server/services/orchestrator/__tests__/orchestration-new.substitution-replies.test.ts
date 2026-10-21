import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE THREE EDITS THAT ARE THE FEATURE (#3665), driven end to end.
 *
 * A sibling test covers `formatGenerationResponse2`'s allowlist passthrough.
 * That is the trap, but it is only ONE of the four production changes, and an
 * audit proved the other three were untested by deleting each and watching CI
 * stay green:
 *
 *   F — the whatIf reply attach  (the half #3665 says matters most)
 *   G — the submit reply attach
 *   H — the metadata persist     (`metadata: workflowMetadata`, dropping the key)
 *
 * All three could be removed and every suite passed. That is precisely the
 * failure this PR exists to prevent, applied to the PR itself: a field that is
 * plumbed, typechecked, reviewed, and reaches nobody.
 *
 * So this drives the REAL `generationGraph.safeParse` through the REAL
 * `whatIfFromGraph` / `generateFromGraph`, with only the orchestrator HTTP call
 * and the heavy DB/redis module graph stubbed. The substitution is produced by
 * the actual clamp on a real `modelLocked` ecosystem — not by hand-feeding a
 * collector — so a change to the graph that stops recording also fails here.
 *
 * 🔴 `TimeSpan` IS STUBBED, AND HAS TO BE. `@civitai/orchestration-client`'s entry does
 * `export * from './generated'` — a directory specifier Node ESM rejects — so
 * under vitest `TimeSpan` resolves to an OBJECT, not a constructor, and
 * `new TimeSpan(...)` throws at import time. `vi.importActual` fails the same
 * way. The stub is a plain class with the same shape; nothing here asserts on
 * it. If this ever starts failing with "TimeSpan is not a constructor", that is
 * the cause, and the real fix is a vitest alias for that package rather than
 * more mocking here.
 */

vi.mock('@civitai/orchestration-client', async () =>
  (await import('./civitai-client.stub')).civitaiClientStub()
);

// `vi.hoisted` because `vi.mock` factories are lifted above every top-level
// binding — referencing a plain `const` from one throws "Cannot access
// 'submitWorkflow' before initialization", and that surfaces as `no tests`
// rather than as a failure.
const { submitWorkflow, deleteWorkflow } = vi.hoisted(() => ({
  // `deleteWorkflow` is reached only by assertWorkflowOwner's mismatch path; without it in the
  // mock that path dies on a missing export instead of on its own assertion.
  deleteWorkflow: vi.fn(async () => undefined),
  submitWorkflow: vi.fn(async ({ body }: { body: Record<string, unknown> }) => ({
    // 🔴 The `<userId>-<timestamp>` shape is load-bearing, not decoration. `assertWorkflowOwner`
    // runs on this reply and FAILS OPEN on an id with no numeric prefix, so the previous `wf-1`
    // silently disabled that guard for every test in this file — including the happy path, which
    // then asserted nothing about it. `1` matches `common.userId`.
    id: '1-20260101000000000',
    status: 'succeeded',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    steps: [],
    cost: { total: 60 },
    transactions: { list: [] },
    // The orchestrator echoes the submitted metadata back on every read — that
    // round-trip is what makes the persisted record survive to later polls.
    metadata: body.metadata,
  })),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({ submitWorkflow, deleteWorkflow }));
// The one observable that separates "the owner guard ran and agreed" from "the owner guard fell
// open". Without asserting on it, reverting the fixture id to a non-numeric prefix silently
// disables the guard for every test here again, exactly as it was before.
const { observeConsumerUnverifiable } = vi.hoisted(() => ({
  observeConsumerUnverifiable: vi.fn(),
}));
vi.mock('~/server/orchestrator/orchestrator-identity-metrics', () => ({
  observeConsumerMismatch: vi.fn(),
  observeConsumerUnverifiable,
}));

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn() }, get: vi.fn(), set: vi.fn() },
    sysRedis: { hGet: vi.fn() },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
    withSysReadDeadline: vi.fn((p: Promise<unknown>) => p),
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
// Prompt moderation is not what this file is about; keep it inert. 🔴 These are
// the paths `orchestration-new.service` actually imports — mocking a plausible
// but WRONG path (e.g. `~/server/services/moderation/*`) silently loads the real
// module instead, and the failure surfaces deep inside it rather than as a
// missing mock.
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createXGuardModerationRequest: vi.fn(async () => undefined),
}));

import {
  generateFromGraph,
  whatIfFromGraph,
} from '~/server/services/orchestrator/orchestration-new.service';
import {
  createModelSubstitutionCollector,
  WORKFLOW_METADATA_MODEL_SUBSTITUTIONS_KEY,
} from '~/shared/generation/model-substitution';
import { classifyModelSubstitutionReason } from '~/shared/generation/workflow-capability';
import { getWorkflowCapability } from '~/shared/generation/workflow-capability';
import { getResourceData } from '~/server/services/generation/generation.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

/** An id no ecosystem has ever heard of — #3665's own probe. */
const UNRECOGNIZED_ID = 987654321;
const QWEN_DEFAULT = getWorkflowCapability('Qwen', 'txt2img')?.defaultModelId as number;

/** A server-shaped context carrying a fresh per-request collector. */
function ctx(overrides: Record<string, unknown> = {}) {
  return {
    limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
    user: { isMember: false, tier: 'free' },
    flags: {},
    selfHostedDisabledEcosystems: [],
    selfHostedMode: 'enabled',
    gateRules: [],
    modelSubstitutions: createModelSubstitutionCollector(classifyModelSubstitutionReason, 'api'),
    ...overrides,
  } as never;
}

function input(modelVersionId?: number) {
  return {
    workflow: 'txt2img',
    ecosystem: 'Qwen',
    ...(modelVersionId != null ? { model: { id: modelVersionId } } : {}),
    resources: [],
    prompt: 'a cat',
    sampler: 'Euler',
    steps: 25,
    quantity: 1,
    priority: 'low',
  };
}

const common = { userId: 1, isModerator: false, token: 't', experimental: false } as const;

// A `disabled` version is deliberately still selectable and still parses, so
// this refusal is the ONLY thing between it and a billed submit. `QWEN_DEFAULT`
// rather than an arbitrary id: an unrecognised one is substituted away before
// the refusal is reached, and the test would pass for the wrong reason.
describe('gate rules — a disabled version is refused, not costed', () => {
  const disabledRule = {
    id: 'gate-1',
    name: 'maintenance',
    availableTo: 'nobody',
    presentation: 'disabled',
    message: 'Back Monday.',
    ecosystems: [],
    workflows: [],
    modelVersionIds: [QWEN_DEFAULT],
  };

  it('🔴 refuses the zero-spend estimate', async () => {
    await expect(
      whatIfFromGraph({
        input: input(QWEN_DEFAULT),
        externalCtx: ctx({ gateRules: [disabledRule] }),
        ...common,
      } as never)
    ).rejects.toThrow('This model version is currently unavailable. Back Monday.');
  });

  it('🔴 refuses the submit', async () => {
    await expect(
      generateFromGraph({
        input: input(QWEN_DEFAULT),
        externalCtx: ctx({ gateRules: [disabledRule] }),
        ...common,
      } as never)
    ).rejects.toThrow('This model version is currently unavailable. Back Monday.');
  });

  // Negative control: the same input with no rules must get past the refusal,
  // or the two assertions above would pass on any unrelated failure.
  it('lets the same request through when no rule targets it', async () => {
    const result = (await whatIfFromGraph({
      input: input(QWEN_DEFAULT),
      externalCtx: ctx(),
      ...common,
    } as never)) as { modelSubstitutions?: unknown };

    expect(result.modelSubstitutions).toBeUndefined();
  });
});

describe('whatIfFromGraph — reply carries the substitution (mutant F)', () => {
  it('🔴 reports the swap on the zero-spend estimate', async () => {
    const result = (await whatIfFromGraph({
      input: input(UNRECOGNIZED_ID),
      externalCtx: ctx(),
      ...common,
    } as never)) as { modelSubstitutions?: unknown };

    expect(result.modelSubstitutions).toEqual([
      { requested: UNRECOGNIZED_ID, applied: QWEN_DEFAULT, reason: 'unrecognized' },
    ]);
  });

  it('omits the key when the requested version is valid', async () => {
    const result = (await whatIfFromGraph({
      input: input(QWEN_DEFAULT),
      externalCtx: ctx(),
      ...common,
    } as never)) as Record<string, unknown>;

    expect('modelSubstitutions' in result).toBe(false);
  });
});

describe('whatIfFromGraph — reply carries the orchestrator step warnings', () => {
  const retiring = {
    code: 'modelDeprecated',
    message: "Model 'max' is deprecated and will be retired on 2026-10-09.",
  };

  // The reply is the ONLY carrier: read off the steps the ORCHESTRATOR returned, not the step
  // templates this service built — those never carry warnings, and reading them compiles.
  it('🔴 reports one warning per distinct code + message', async () => {
    submitWorkflow.mockImplementationOnce(async () => ({
      id: '1-20260101000000000',
      status: 'succeeded',
      createdAt: new Date('2020-01-01T00:00:00Z'),
      steps: [{ warnings: [retiring] }, { warnings: [{ ...retiring }] }],
      cost: { total: 60 },
      transactions: { list: [] },
    }));

    const result = (await whatIfFromGraph({
      input: input(QWEN_DEFAULT),
      externalCtx: ctx(),
      ...common,
    } as never)) as { warnings?: unknown };

    expect(result.warnings).toEqual([retiring]);
  });

  it('omits the key when the orchestrator sends no warnings', async () => {
    const result = (await whatIfFromGraph({
      input: input(QWEN_DEFAULT),
      externalCtx: ctx(),
      ...common,
    } as never)) as Record<string, unknown>;

    expect('warnings' in result).toBe(false);
  });
});

describe('generateFromGraph — reply + persistence (mutants G and H)', () => {
  // 🔴 PIN THE MODE. `ORCHESTRATOR_MODE` derives from the schema's `.default('dev')`, and
  // `assertWorkflowOwner` short-circuits in dev (every user shares the system token there). Left
  // unpinned, the owner guard on this procedure's submit reply is disabled for the whole file and
  // the mismatch case below is unreachable — the same silent-disable the `wf-1` fixture caused.
  beforeEach(() => {
    setEnv({ ORCHESTRATOR_MODE: 'prod' });
    observeConsumerUnverifiable.mockClear();
  });
  afterAll(() => {
    resetEnv();
  });

  it('🔴 attaches the substitution to the submit reply', async () => {
    const result = (await generateFromGraph({
      input: input(UNRECOGNIZED_ID),
      externalCtx: ctx(),
      ...common,
    } as never)) as { modelSubstitutions?: unknown };

    expect(result.modelSubstitutions).toEqual([
      { requested: UNRECOGNIZED_ID, applied: QWEN_DEFAULT, reason: 'unrecognized' },
    ]);
  });

  it('🔴 PERSISTS it on the submitted workflow metadata — the half that survives to later reads', async () => {
    submitWorkflow.mockClear();
    await generateFromGraph({
      input: input(UNRECOGNIZED_ID),
      externalCtx: ctx(),
      ...common,
    } as never);

    const body = submitWorkflow.mock.calls[0][0].body as Record<string, unknown>;
    const metadata = body.metadata as Record<string, unknown>;
    expect(metadata[WORKFLOW_METADATA_MODEL_SUBSTITUTIONS_KEY]).toEqual([
      { requested: UNRECOGNIZED_ID, applied: QWEN_DEFAULT, reason: 'unrecognized' },
    ]);
  });

  it('🔴 the persisted record survives the orchestrator round-trip into the formatted reply', async () => {
    // The end-to-end property that actually matters: submit -> persisted on the
    // workflow -> echoed back -> SURFACED by the formatter's allowlist. A poll
    // or history read rebuilds from exactly this path.
    const result = (await generateFromGraph({
      input: input(UNRECOGNIZED_ID),
      externalCtx: ctx(),
      ...common,
    } as never)) as { metadata?: { modelSubstitutions?: unknown } };

    expect(result.metadata?.modelSubstitutions).toEqual([
      { requested: UNRECOGNIZED_ID, applied: QWEN_DEFAULT, reason: 'unrecognized' },
    ]);
  });

  it('writes NO substitution key when the requested version is valid', async () => {
    submitWorkflow.mockClear();
    const result = (await generateFromGraph({
      input: input(QWEN_DEFAULT),
      externalCtx: ctx(),
      ...common,
    } as never)) as Record<string, unknown>;

    const body = submitWorkflow.mock.calls[0][0].body as Record<string, unknown>;
    const metadata = (body.metadata ?? {}) as Record<string, unknown>;
    expect(WORKFLOW_METADATA_MODEL_SUBSTITUTIONS_KEY in metadata).toBe(false);
    expect('modelSubstitutions' in result).toBe(false);
    // The owner guard actually CHECKED this submit. `<userId>-<timestamp>` on the fixture is
    // load-bearing: a non-numeric prefix makes the guard fail open, and every assertion above
    // still passes while it silently does nothing.
    expect(observeConsumerUnverifiable).not.toHaveBeenCalled();
  });

  // The guard's ONLY production call site. Its unit tests cover the function; this covers the
  // wiring — deleting the `await assertWorkflowOwner(...)` line from generateFromGraph leaves
  // every other test in the repo green.
  it('REJECTS a submit the orchestrator attributed to another user, and tears it down', async () => {
    submitWorkflow.mockClear();
    deleteWorkflow.mockClear();
    const strangersWorkflow = '2002-20260101000000000';
    submitWorkflow.mockResolvedValueOnce({
      id: strangersWorkflow,
      status: 'succeeded',
      createdAt: new Date('2020-01-01T00:00:00Z'),
      steps: [],
      cost: { total: 60 },
      transactions: { list: [] },
      metadata: {},
    });

    await expect(
      generateFromGraph({ input: input(QWEN_DEFAULT), externalCtx: ctx(), ...common } as never)
    ).rejects.toThrow(/could not confirm who this generation belongs to/i);

    expect(deleteWorkflow).toHaveBeenCalledTimes(1);
    expect(deleteWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: strangersWorkflow, throwOnError: true })
    );
  });
});

describe('generateFromGraph — creator tip vs resource eligibility', () => {
  const tips = { civitaiTip: 0.05, creatorTip: 0.25 };

  /** The resolved Qwen checkpoint, generatable, with its owner's tip eligibility. */
  const resource = (tipsEnabled: boolean, isOwnedByUser = false) => ({
    id: QWEN_DEFAULT,
    name: 'Qwen',
    air: `urn:air:qwen:checkpoint:civitai:1@${QWEN_DEFAULT}`,
    baseModel: 'Qwen',
    trainedWords: [],
    availability: 'Public',
    canGenerate: true,
    hasAccess: true,
    strength: 1,
    settings: { strength: { min: -1, max: 2, default: 1 } },
    model: { id: 1, name: 'Qwen', type: 'Checkpoint', poi: false },
    tipsEnabled,
    isOwnedByUser,
  });

  beforeEach(() => {
    setEnv({ ORCHESTRATOR_MODE: 'prod' });
    submitWorkflow.mockClear();
  });
  afterAll(() => {
    resetEnv();
  });

  async function submittedTips(resources: unknown[]) {
    vi.mocked(getResourceData).mockResolvedValueOnce(resources as never);
    await generateFromGraph({
      input: input(QWEN_DEFAULT),
      externalCtx: ctx(),
      ...common,
      ...tips,
    } as never);
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    return (submitWorkflow.mock.calls[0][0].body as Record<string, unknown>).tips;
  }

  it('drops the creator tip when the only resource is tip-exempt, keeping the Civitai tip', async () => {
    expect(await submittedTips([resource(false)])).toEqual({ civitai: 0.05, creators: 0 });
  });

  it('passes the creator tip through when a resource is tip-eligible', async () => {
    expect(await submittedTips([resource(true)])).toEqual({ civitai: 0.05, creators: 0.25 });
  });

  it("drops the creator tip when the only eligible resource is the user's own", async () => {
    expect(await submittedTips([resource(true, true)])).toEqual({ civitai: 0.05, creators: 0 });
  });

  it('drops the creator tip when no resource resolves', async () => {
    expect(await submittedTips([])).toEqual({ civitai: 0.05, creators: 0 });
  });
});
