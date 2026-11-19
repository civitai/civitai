import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MiddlewareTrpc from '~/server/middleware.trpc';

// The public `generation.getStatus` is edge-cached. A cold pod that cannot read the kill switch
// answers a fail-closed "temporarily unavailable" fallback; that answer must not be cached at the
// edge, where it would be served to everyone for the TTL after the pod recovers.

const { mockGetGenerationStatus, mockGetGenerationStatusState } = vi.hoisted(() => ({
  mockGetGenerationStatus: vi.fn(),
  mockGetGenerationStatusState: vi.fn(),
}));

vi.mock('~/server/services/generation/generation.service', () => ({
  checkResourcesCoverage: vi.fn(),
  getGenerationData: vi.fn(),
  getGenerationStatus: mockGetGenerationStatus,
  getGenerationStatusState: mockGetGenerationStatusState,
  getGateRules: vi.fn(),
  getGeneratorMessages: vi.fn(),
  getGenerationConfig: vi.fn(),
  getResourceData: vi.fn(),
  resolveImageMeta: vi.fn(),
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

const status = (mode: 'enabled' | 'disabled', message: string | null) => ({
  mode,
  message,
  selfHostedMode: mode,
  limits: {},
  charge: true,
  available: mode !== 'disabled',
});
const FALLBACK = status(
  'disabled',
  'Generation is temporarily unavailable. Please try again in a few minutes.'
);

function call() {
  const cache: { edgeTTL: number; skip?: boolean } = { edgeTTL: 0 };
  const caller = generationRouter.createCaller({
    user: undefined,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache,
    features: {},
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
  return { cache, result: caller.getStatus() };
}

beforeEach(() => {
  mockGetGenerationStatus.mockReset();
  mockGetGenerationStatusState.mockReset();
});

describe('generation.getStatus edge caching', () => {
  it('does NOT edge-cache the fail-closed fallback served while the kill switch is unknown', async () => {
    mockGetGenerationStatus.mockResolvedValue(FALLBACK);
    mockGetGenerationStatusState.mockResolvedValue({ status: FALLBACK, known: false });

    const { cache, result } = call();

    expect((await result).mode).toBe('disabled');
    expect(cache.skip).toBe(true);
  });

  it('edge-caches a status that was actually read (an operator-disabled generator included)', async () => {
    const real = status('disabled', 'maintenance');
    mockGetGenerationStatus.mockResolvedValue(real);
    mockGetGenerationStatusState.mockResolvedValue({ status: real, known: true });

    const { cache, result } = call();

    expect((await result).message).toBe('maintenance');
    expect(cache.skip).toBeUndefined();
  });
});
