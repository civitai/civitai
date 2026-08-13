import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `generation.getGenerationData` is a publicProcedure keyed on an image id, so an
 * image with `hideMeta` set is only protected if the READ refuses. `hasMeta`
 * (`meta IS NOT NULL AND NOT hideMeta`) decides whether a remix button renders and
 * nothing more — a caller that skips the listing still gets a payload.
 *
 * This pins the refusal on the read: hidden prompt text is absent from the remix
 * params for everyone except the uploader and moderators, while the rest of the
 * payload (resources, seed, dimensions) still seeds a remix.
 */

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn(), mGet: vi.fn() }, get: vi.fn(), set: vi.fn() },
    sysRedis: { hGet: vi.fn() },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
    withSysReadDeadline: vi.fn((p: Promise<unknown>) => p),
  };
});
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/ecosystems/wan.handler', () => ({
  wanBaseModelGroupIdMap: {},
}));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: {} }));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: vi.fn() }));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: {} }));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({
  getLinkedVaeIds: vi.fn(),
  bustMvCache: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({ imagesForModelVersionsCache: {} }));
vi.mock('~/server/services/generation/version-generation-state.service', () => ({
  getVisibleSystemWildcardSetIdsByVersionId: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

const findUnique = vi.fn();
vi.mock('~/server/db/client', () => ({
  dbRead: {
    image: { findUnique: (...args: unknown[]) => findUnique(...args) },
    // No stored resource rows: `getResourceData([])` short-circuits, so the whole
    // resource-enrichment path stays out of this test.
    imageResourceNew: { findMany: vi.fn().mockResolvedValue([]) },
  },
  dbWrite: {},
}));

import { getGenerationData } from '~/server/services/generation/generation.service';
import type { SessionUser } from '~/types/session';

const OWNER_ID = 555;

const PROMPT = 'a very secret prompt';
const NEGATIVE_PROMPT = 'a very secret negative prompt';

const baseMeta = {
  prompt: PROMPT,
  negativePrompt: NEGATIVE_PROMPT,
  steps: 30,
  cfgScale: 7,
  seed: 12345,
  sampler: 'Euler a',
};

function mockImage(meta: Record<string, unknown>, hideMeta: boolean) {
  findUnique.mockResolvedValue({
    id: 1,
    type: 'image',
    url: 'some-url',
    meta,
    hideMeta,
    userId: OWNER_ID,
    height: 1024,
    width: 1024,
    createdAt: new Date('2026-01-01'),
  });
}

const getParams = async (user?: { id: number; isModerator: boolean }) => {
  const data = await getGenerationData({
    query: { type: 'image', id: 1, generation: false },
    user: user as SessionUser | undefined,
  });
  return data.params;
};

const owner = { id: OWNER_ID, isModerator: false };
const moderator = { id: 999, isModerator: true };
const otherUser = { id: 999, isModerator: false };

describe('getGenerationData - hidden prompt', () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it('strips prompt and negativePrompt for an anonymous caller when hideMeta is set', async () => {
    mockImage(baseMeta, true);

    const params = await getParams();

    expect(params.prompt).toBeUndefined();
    expect(params.negativePrompt).toBeUndefined();
    expect(JSON.stringify(params)).not.toContain(PROMPT);
    expect(JSON.stringify(params)).not.toContain(NEGATIVE_PROMPT);
  });

  it('strips prompt and negativePrompt for a signed-in non-owner when hideMeta is set', async () => {
    mockImage(baseMeta, true);

    const params = await getParams(otherUser);

    expect(params.prompt).toBeUndefined();
    expect(params.negativePrompt).toBeUndefined();
  });

  it('keeps the non-prompt params so the remix is still seeded', async () => {
    mockImage(baseMeta, true);

    const params = await getParams();

    expect(params.steps).toBe(30);
    expect(params.cfgScale).toBe(7);
    expect(params.seed).toBe(12345);
    expect(params.sampler).toBe('Euler a');
  });

  it('drops the raw comfy blob, which carries the prompt in its nodes', async () => {
    mockImage({ ...baseMeta, comfy: `{"prompt": {"6": {"inputs": {"text": "${PROMPT}"}}}}` }, true);

    const params = await getParams();

    expect(params.comfy).toBeUndefined();
    expect(JSON.stringify(params)).not.toContain(PROMPT);
  });

  it('drops unknown string fields whose key mentions prompt, but keeps non-string settings', async () => {
    mockImage(
      { ...baseMeta, positivePrompt: PROMPT, enablePromptEnhancer: true, promptStrength: 0.8 },
      true
    );

    const params = await getParams();

    expect(params.positivePrompt).toBeUndefined();
    expect(params.enablePromptEnhancer).toBe(true);
    expect(params.promptStrength).toBe(0.8);
  });

  it('returns the prompt to the uploader', async () => {
    mockImage(baseMeta, true);

    const params = await getParams(owner);

    expect(params.prompt).toBe(PROMPT);
    expect(params.negativePrompt).toBe(NEGATIVE_PROMPT);
  });

  it('returns the prompt to a moderator', async () => {
    mockImage(baseMeta, true);

    const params = await getParams(moderator);

    expect(params.prompt).toBe(PROMPT);
    expect(params.negativePrompt).toBe(NEGATIVE_PROMPT);
  });

  it('returns the prompt to anyone when hideMeta is not set', async () => {
    mockImage(baseMeta, false);

    const params = await getParams();

    expect(params.prompt).toBe(PROMPT);
    expect(params.negativePrompt).toBe(NEGATIVE_PROMPT);
  });
});
