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
  setEvictable: vi.fn(),
  setAdditionalResourceFeeWaived: vi.fn(),
}));
vi.mock('~/server/services/wildcard-pack.service', () => ({
  resolveWildcardPackForUser: vi.fn(),
}));
vi.mock('~/server/services/resource-file.service', () => ({
  resolveResourceFileForUser: vi.fn(),
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

const req = { headers: {} };

const callerFor = (apiKeyId: number | null) =>
  generationRouter.createCaller({
    user: { id: 5 },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId,
    req,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetResourceData.mockResolvedValue([]);
});

const optIn = () =>
  (mockGetResourceData.mock.calls[0] as unknown as [unknown, { acceptBoostRequired?: boolean }])[1]
    .acceptBoostRequired;

/**
 * The generator form re-reads its resources from this route and drops any with `canGenerate: false`
 * before submit. Without the opt-in here, a free account's boosted checkpoint is stripped from the
 * submit its whatIf priced.
 */
describe('getResourceDataByIds — the boost-to-load opt-in', () => {
  it("passes the generator form's opt-in through for a session", async () => {
    await callerFor(null).getResourceDataByIds({ ids: [1], acceptBoostRequired: true });
    expect(optIn()).toBe(true);
  });

  it('never passes it for an API key', async () => {
    await callerFor(42).getResourceDataByIds({ ids: [1], acceptBoostRequired: true });
    expect(optIn()).toBe(false);
  });

  it('leaves it off when the caller did not ask', async () => {
    await callerFor(null).getResourceDataByIds({ ids: [1] });
    expect(optIn()).toBe(false);
  });
});
