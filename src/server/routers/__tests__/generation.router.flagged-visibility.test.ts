import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MiddlewareTrpc from '~/server/middleware.trpc';

const { mockGetGenerationData, mockGetResourceData } = vi.hoisted(() => ({
  mockGetGenerationData: vi.fn(),
  mockGetResourceData: vi.fn(),
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

/**
 * Resource lookups by version id leave out resources of a model flagged `poi`, except for its
 * owner and moderators.
 */

const OWNER = 7;
const FLAGGED = { id: 100, model: { id: 1, poi: true, userId: OWNER } };
const CONTROL = { id: 200, model: { id: 2, poi: false, userId: 8 } };

const VIEWERS = {
  anon: undefined,
  other: { id: 9, isModerator: false },
  owner: { id: OWNER, isModerator: false },
  moderator: { id: 1, isModerator: true },
} as const;
type ViewerKey = keyof typeof VIEWERS;

function caller(viewer: ViewerKey) {
  return generationRouter.createCaller({
    user: VIEWERS[viewer],
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

const ids = (resources: { id: number }[]) => resources.map((r) => r.id);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetResourceData.mockResolvedValue([FLAGGED, CONTROL]);
  mockGetGenerationData.mockResolvedValue({ resources: [FLAGGED, CONTROL], params: {} });
});

describe.each<[ViewerKey, number[]]>([
  ['anon', [CONTROL.id]],
  ['other', [CONTROL.id]],
  ['owner', [FLAGGED.id, CONTROL.id]],
  ['moderator', [FLAGGED.id, CONTROL.id]],
])('%s', (viewer, expected) => {
  it('getResourceDataByIds', async () => {
    expect(ids(await caller(viewer).getResourceDataByIds({ ids: [100, 200] }))).toEqual(expected);
  });

  it.each([
    { type: 'modelVersion' as const, id: 100 },
    { type: 'modelVersions' as const, ids: [100, 200] },
  ])('getGenerationData $type', async (input) => {
    const data = await caller(viewer).getGenerationData(input as never);
    expect(ids(data.resources)).toEqual(expected);
  });
});
