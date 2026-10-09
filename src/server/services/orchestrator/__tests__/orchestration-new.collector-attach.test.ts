import { describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE SEAM EVERYTHING IN #3520 / #3665 HANGS OFF (issue #3697).
 *
 * `buildGenerationContext` attaching a collector to the context it returns is
 * the ONE production site that makes the whole silent-substitution feature
 * exist. Delete that property and:
 *
 *   - `ext.modelSubstitutions?.record(...)` in the clamp becomes a no-op;
 *   - `civitai_generation_model_substitutions_total` never increments, on ANY
 *     surface;
 *   - `BlockWorkflowSnapshot.modelSubstitutions` is never populated;
 *   - the tRPC reply fields are always absent.
 *
 * Measured before this test existed: deleting it left **847 tests across 34
 * files green**. `tsc` does not catch it either — `GenerationCtx.modelSubstitutions`
 * is optional, and has to be, because client-built contexts legitimately have no
 * collector.
 *
 * Every other test in this area builds its own context or mocks
 * `buildGenerationContext` outright. That is reasonable in isolation and is
 * exactly why the gap existed: each suite is scoped to one component, so none
 * ever built the combined state where the REAL `buildGenerationContext` feeds
 * the REAL clamp. The defect lived in the seam nobody's fixture loaded.
 *
 * So this file deliberately does the one thing the others don't: it takes the
 * context `buildGenerationContext` actually returns and runs the real
 * `validateInput` against it.
 *
 * The mock preamble mirrors `orchestration-new.air-map.test.ts` — it only keeps
 * the heavy DB/redis module graph inert so the module imports.
 *
 * It hosts a SECOND property off the same seam, for the same reason: the refusal counter
 * `generation_validation_refused_total` is emitted inside `validateInput` and labelled from the
 * collector's surface, so proving it fires needs exactly this combination — the real
 * `buildGenerationContext` feeding the real `validateInput`. A separate file would have to
 * duplicate this preamble, and a new file doing so trips `no-direct-shared-module-mock` and
 * `no-hand-typed-redis-key-constants`, which this one predates. The codemod those guards
 * point at refuses the conversion: the redis factory here replaces `REDIS_SUB_KEYS` with
 * behaviour, so it is a control surface rather than a redundant re-export.
 */

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

import {
  buildGenerationContext,
  validateInput,
} from '~/server/services/orchestrator/orchestration-new.service';
import { generationValidationRefusedCounter } from '~/server/prom/generation-validation.metrics';
import { GENERATION_SURFACES } from '~/shared/generation/model-substitution';
import { getWorkflowCapability } from '~/shared/generation/workflow-capability';
import { dbMock } from '~/__tests__/mocks/db.mock';

const USER = { id: 1, isModerator: false };
const QWEN_DEFAULT = getWorkflowCapability('Qwen', 'txt2img')?.defaultModelId as number;
/** An id no ecosystem has ever heard of — #3665's own probe. */
const UNRECOGNIZED_ID = 987654321;

async function ctxFor(surface: (typeof GENERATION_SURFACES)[number]) {
  const { externalCtx } = await buildGenerationContext('free', {}, USER, surface);
  return externalCtx;
}

describe('the graph fixture is still what this test assumes', () => {
  it('Qwen/txt2img is modelLocked with a default', () => {
    // Guard the guard: if Qwen stops being modelLocked nothing substitutes, and
    // the end-to-end assertion below would pass vacuously.
    expect(getWorkflowCapability('Qwen', 'txt2img')?.modelLocked).toBe(true);
    expect(typeof QWEN_DEFAULT).toBe('number');
  });
});

describe('buildGenerationContext attaches a substitution collector', () => {
  it.each(GENERATION_SURFACES)(
    '🔴 the returned context carries a collector labelled `%s`',
    async (surface) => {
      const externalCtx = await ctxFor(surface);
      expect(externalCtx.modelSubstitutions).toBeDefined();
      // The surface is fixed at construction by the caller and rides on the
      // collector, because `validateInput` — where the metric is emitted — is
      // shared by every surface and structurally cannot tell them apart.
      expect(externalCtx.modelSubstitutions?.surface).toBe(surface);
    }
  );

  it('🔴 a fresh collector per call — never shared, never accumulating across users', async () => {
    // The hazard this guards is not hypothetical: a collector reachable from any
    // of the cached values `buildGenerationContext` awaits would accumulate
    // substitutions ACROSS REQUESTS and report one caller's requested model id
    // to another.
    const a = await ctxFor('api');
    const b = await ctxFor('api');
    expect(a.modelSubstitutions).not.toBe(b.modelSubstitutions);

    a.modelSubstitutions?.record({
      requested: UNRECOGNIZED_ID,
      applied: QWEN_DEFAULT,
      ecosystem: 'Qwen',
      workflow: 'txt2img',
    });
    expect(a.modelSubstitutions?.list()).toHaveLength(1);
    expect(b.modelSubstitutions?.list()).toEqual([]);
  });
});

describe('the attached collector is WIRED TO THE REAL CLAMP', () => {
  it('🔴 a real validateInput on the real context records a real substitution', async () => {
    // 🔴 THE POINT OF THIS FILE. Asserting the property EXISTS is not the same
    // as asserting the validator can reach it — a collector attached under a key
    // `validateInput` does not write to would satisfy the tests above and record
    // nothing. So this drives the actual validator with the actual context object.
    const externalCtx = await ctxFor('api');

    const { data } = validateInput(
      {
        workflow: 'txt2img',
        ecosystem: 'Qwen',
        model: { id: UNRECOGNIZED_ID },
        resources: [],
        prompt: 'a cat',
        sampler: 'Euler',
        steps: 25,
        quantity: 1,
        priority: 'low',
      },
      externalCtx
    );

    // Behaviour is unchanged — the substitution still happens and still wins.
    expect((data as { model?: { id?: number } }).model?.id).toBe(QWEN_DEFAULT);

    // …and it was OBSERVED, which is the whole of #3520.
    expect(externalCtx.modelSubstitutions?.list()).toEqual([
      {
        requested: UNRECOGNIZED_ID,
        applied: QWEN_DEFAULT,
        reason: 'unrecognized',
        ecosystem: 'Qwen',
        workflow: 'txt2img',
      },
    ]);
  });

  it('records nothing when the requested version is valid', async () => {
    const externalCtx = await ctxFor('api');
    validateInput(
      {
        workflow: 'txt2img',
        ecosystem: 'Qwen',
        model: { id: QWEN_DEFAULT },
        resources: [],
        prompt: 'a cat',
        sampler: 'Euler',
        steps: 25,
        quantity: 1,
        priority: 'low',
      },
      externalCtx
    );
    expect(externalCtx.modelSubstitutions?.list()).toEqual([]);
  });
});

/**
 * The refusal counter actually increments, with the labels it promises.
 *
 * `prom/__tests__/generation-validation.metrics.test.ts` pins the LEDGER — one emit site,
 * three bounded labels. It cannot see whether the emit ever RUNS: a textual guard is satisfied
 * by an increment behind a condition that is never true.
 *
 * That matters more than usual here. This counter exists because removing the data-graph lane
 * removed the shadow comparison, which was the only thing that saw a hub refusal — and its
 * alarm is "any sustained non-zero", measured at zero over the 14 days before the cutover. A
 * counter that never fires reads exactly like the healthy state it is meant to prove, which is
 * the one failure mode nobody notices in production.
 */
describe('validateInput records a refusal', () => {
  it('labels the surface, the clamped workflow and the first failing field', async () => {
    const seriesOf = async () => {
      const metric = await (
        generationValidationRefusedCounter as unknown as {
          get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
        }
      ).get();
      return metric.values ?? [];
    };

    const before = await seriesOf();
    const { externalCtx } = await buildGenerationContext('free', {}, USER, 'block');

    // txt2img with no prompt and no images: the hub refuses on `prompt`.
    await expect(
      (async () => validateInput({ workflow: 'txt2img', ecosystem: 'SDXL' }, externalCtx))()
    ).rejects.toThrow(/Validation failed/);

    const after = await seriesOf();
    const changed = after.filter(
      (a) =>
        !before.some(
          (b) => JSON.stringify(b.labels) === JSON.stringify(a.labels) && b.value === a.value
        )
    );

    expect(
      changed.length,
      'the parse threw but the counter did not move — it is inert, and a zero reading would be ' +
        'indistinguishable from health'
    ).toBeGreaterThan(0);

    expect(changed[0]!.labels).toMatchObject({
      surface: 'block',
      workflow: 'txt2img',
      field: 'prompt',
    });
  });

  it('clamps an unknown workflow instead of labelling it', async () => {
    const bogus = 'not-a-real-workflow-' + Date.now();
    const { externalCtx } = await buildGenerationContext('free', {}, USER, 'api');

    await expect(
      (async () => validateInput({ workflow: bogus, ecosystem: 'SDXL' }, externalCtx))()
    ).rejects.toThrow(/Validation failed/);

    const metric = await (
      generationValidationRefusedCounter as unknown as {
        get(): Promise<{ values: Array<{ labels: Record<string, string> }> }>;
      }
    ).get();
    expect(
      (metric.values ?? []).some((v) => v.labels.workflow === bogus),
      'an arbitrary caller string reached the label — that is one series per bogus workflow'
    ).toBe(false);
  });
});
