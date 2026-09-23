import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MiddlewareTrpc from '~/server/middleware.trpc';

const { mockGetGenerationData, mockGetResourceData, mockResolveImageMeta } = vi.hoisted(() => ({
  mockGetGenerationData: vi.fn(),
  mockGetResourceData: vi.fn(),
  mockResolveImageMeta: vi.fn(),
}));

// Cuts to keep Prisma, Redis and the orchestrator off the load path.
vi.mock('~/server/services/generation/generation.service', () => ({
  checkResourcesCoverage: vi.fn(),
  getGenerationData: mockGetGenerationData,
  getGenerationStatus: vi.fn(),
  getGateRules: vi.fn(),
  getGeneratorMessages: vi.fn(),
  getGenerationConfig: vi.fn(),
  getResourceData: mockGetResourceData,
  resolveImageMeta: mockResolveImageMeta,
  saveGateRule: vi.fn(),
  deleteGateRule: vi.fn(),
  saveGeneratorMessage: vi.fn(),
  deleteGeneratorMessage: vi.fn(),
  setGenerationStatus: vi.fn(),
  setSelfHostedGenerationStatus: vi.fn(),
  toggleGenerationDisabled: vi.fn(),
}));
vi.mock('~/server/services/wildcard-pack.service', () => ({
  resolveWildcardPackForUser: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/comfy/comfy.utils', () => ({
  getWorkflowDefinitions: vi.fn(),
  setWorkflowDefinition: vi.fn(),
}));
vi.mock('~/server/middleware.trpc', async (importOriginal) => {
  const { middleware } = await import('~/server/trpc');
  const passthrough = () => middleware(async ({ next }) => next());
  return {
    ...(await importOriginal<typeof MiddlewareTrpc>()),
    rateLimit: passthrough,
    edgeCacheIt: passthrough,
    purgeOnSuccess: passthrough,
  };
});

import { generationRouter } from '../generation.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const PG = 1;
const SFW = 1 | 2;
const ALL_SELECTABLE = 1 | 2 | 4 | 8 | 16;
const nsfwUser = { id: 5, showNsfw: true, browsingLevel: ALL_SELECTABLE };

function callerFor(user: typeof nsfwUser | undefined, canViewNsfw: boolean | undefined) {
  return generationRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { canViewNsfw },
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

const viewers = [
  ['signed in on the SFW domain', nsfwUser, undefined, SFW],
  ['signed in on a mature domain', nsfwUser, true, ALL_SELECTABLE],
  ['anonymous on a mature domain', undefined, true, PG],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetGenerationData.mockResolvedValue({ resources: [], params: {} });
  mockGetResourceData.mockResolvedValue([]);
  mockResolveImageMeta.mockResolvedValue({ resources: [], params: {} });
});

describe('generation router passes the viewer preview level', () => {
  it.each(viewers)('getGenerationData: %s', async (_label, user, canViewNsfw, expected) => {
    await callerFor(user, canViewNsfw).getGenerationData({ type: 'modelVersion', id: 1 });
    expect(mockGetGenerationData).toHaveBeenCalledTimes(1);
    expect(mockGetGenerationData.mock.calls[0][0].browsingLevel).toBe(expected);
  });

  it.each(viewers)('getResourceDataByIds: %s', async (_label, user, canViewNsfw, expected) => {
    await callerFor(user, canViewNsfw).getResourceDataByIds({ ids: [1] });
    expect(mockGetResourceData).toHaveBeenCalledTimes(1);
    expect(mockGetResourceData.mock.calls[0][1].browsingLevel).toBe(expected);
  });

  it.each(viewers)('resolveImageMeta: %s', async (_label, user, canViewNsfw, expected) => {
    await callerFor(user, canViewNsfw).resolveImageMeta({ metadata: {} });
    expect(mockResolveImageMeta).toHaveBeenCalledTimes(1);
    expect(mockResolveImageMeta.mock.calls[0][0].browsingLevel).toBe(expected);
  });
});
