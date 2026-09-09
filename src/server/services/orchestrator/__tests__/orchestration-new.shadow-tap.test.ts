import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as ShadowParse from '~/server/services/orchestrator/form-graph/shadow-parse';

/**
 * The cutover rides on `validateInput` doing three things: running the shadow
 * comparison exactly once per parse, serving the hub result for a user whose
 * `formGraphGenerator` flag is on, and serving v1 for everyone else. The
 * shadow-parse suite tests the functions, not this caller. Mock preamble
 * mirrors `orchestration-new.collector-attach.test.ts`: it only keeps the
 * heavy DB/redis module graph inert so the module imports.
 */

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

const shadow = vi.hoisted(() => ({
  record: vi.fn(),
  hubResult: undefined as unknown,
}));
vi.mock('~/server/services/orchestrator/form-graph/shadow-parse', async (importOriginal) => {
  const mod = await importOriginal<typeof ShadowParse>();
  return {
    ...mod,
    runHubParse: vi.fn((...args: Parameters<typeof mod.runHubParse>) =>
      shadow.hubResult === undefined ? mod.runHubParse(...args) : shadow.hubResult
    ),
    recordShadowComparison: shadow.record,
  };
});

import { createWorkflowStepsFromGraphInput } from '~/server/services/orchestrator/orchestration-new.service';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { dbMock } from '~/__tests__/mocks/db.mock';

void dbMock;

const ext = (flags: GenerationCtx['flags']): GenerationCtx => ({
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags,
  gateRules: [],
});

const INPUT = { workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'a cat' };

// Step-building may fail on the inert mocks downstream of validateInput; the
// behaviour under test happens (or not) before that.
const run = (externalCtx: GenerationCtx) =>
  createWorkflowStepsFromGraphInput({ input: { ...INPUT }, externalCtx });

describe('validateInput cutover gate', () => {
  beforeEach(() => {
    shadow.record.mockClear();
    shadow.hubResult = undefined;
  });

  it('one parse records exactly one comparison, flag or no flag', async () => {
    await run(ext({})).catch(() => undefined);
    expect(shadow.record).toHaveBeenCalledTimes(1);
    const [v1, hub, workflow] = shadow.record.mock.calls[0];
    expect(v1).toHaveProperty('success');
    expect(hub).toHaveProperty('ok');
    expect(workflow).toBe('txt2img');

    await run(ext({ formGraphGenerator: true })).catch(() => undefined);
    expect(shadow.record).toHaveBeenCalledTimes(2);
  });

  it('the hub result is SERVED only for a user with the flag on', async () => {
    // a hub-only refusal: if the hub is being served, the submit rejects with
    // its message; if v1 is served, the parse succeeds and continues past it
    shadow.hubResult = {
      ok: false,
      errors: { prompt: { message: 'HUB_SERVED_ERROR' } },
    };

    await expect(run(ext({ formGraphGenerator: true }))).rejects.toThrow(/HUB_SERVED_ERROR/);

    const offLane = await run(ext({})).then(
      () => 'v1-served',
      (e) => (String(e).includes('HUB_SERVED_ERROR') ? 'hub-served' : 'v1-served')
    );
    expect(offLane).toBe('v1-served');
  });

  it('a missing flag record serves v1 (the coercion the untruthy-gate guard exists for)', async () => {
    shadow.hubResult = {
      ok: false,
      errors: { prompt: { message: 'HUB_SERVED_ERROR' } },
    };
    const lane = await run(ext(undefined)).then(
      () => 'v1-served',
      (e) => (String(e).includes('HUB_SERVED_ERROR') ? 'hub-served' : 'v1-served')
    );
    expect(lane).toBe('v1-served');
  });
});
