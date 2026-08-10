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
 * `generationGraph.safeParse` against it.
 *
 * The mock preamble mirrors `orchestration-new.air-map.test.ts` — it only keeps
 * the heavy DB/redis module graph inert so the module imports.
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
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
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
  getGenerationEcosystemConfig: vi.fn(async () => ({
    experimentalEcosystems: [],
    hasTestingAccess: false,
  })),
  getGateRules: vi.fn(async () => []),
  getSelfHostedDisabledEcosystems: vi.fn(() => [] as string[]),
  getResourceData: vi.fn(async () => []),
}));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
  imagesForModelVersionsCache: {},
}));

import { buildGenerationContext } from '~/server/services/orchestrator/orchestration-new.service';
import { generationGraph } from '~/shared/data-graph/generation/generation-graph';
import { GENERATION_SURFACES } from '~/shared/data-graph/generation/model-substitution';
import { getWorkflowCapability } from '~/shared/data-graph/generation/workflow-capability';

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
  it('🔴 a real safeParse on the real context records a real substitution', async () => {
    // 🔴 THE POINT OF THIS FILE. Asserting the property EXISTS is not the same
    // as asserting the graph can reach it — a collector attached under a key the
    // clamp does not read would satisfy the tests above and record nothing. So
    // this drives the actual validator with the actual context object.
    const externalCtx = await ctxFor('api');

    const result = generationGraph.safeParse(
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
      } as never,
      externalCtx
    ) as { success: boolean; data?: { model?: { id?: number } } };

    // Behaviour is unchanged — the substitution still happens and still wins.
    expect(result.success).toBe(true);
    expect(result.data?.model?.id).toBe(QWEN_DEFAULT);

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
    generationGraph.safeParse(
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
      } as never,
      externalCtx
    );
    expect(externalCtx.modelSubstitutions?.list()).toEqual([]);
  });
});
