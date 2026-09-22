import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

const { mockSession, mockGetResourceData, mockGetGenerationData, mockFeatureFlagsLazy } =
  vi.hoisted(() => ({
    mockSession: vi.fn(),
    mockGetResourceData: vi.fn(),
    mockGetGenerationData: vi.fn(),
    mockFeatureFlagsLazy: vi.fn(),
  }));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  PublicEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: mockSession }));
vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: mockGetResourceData,
  getGenerationData: mockGetGenerationData,
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsLazy: mockFeatureFlagsLazy,
}));

import generationDataHandler from '~/pages/api/generation/data';
import generationResourcesHandler from '~/pages/api/generation/resources';
import { getRequestBrowsingLevel } from '~/server/utils/browsing-level';

const PG = 1;
const SFW = 1 | 2;
const ALL_SELECTABLE = 1 | 2 | 4 | 8 | 16;

const nsfwUser = { id: 5, showNsfw: true, browsingLevel: ALL_SELECTABLE };
const nsfwOffUser = { id: 6, showNsfw: false, browsingLevel: ALL_SELECTABLE };

// [label, user, canViewNsfw, expected level]
const viewers = [
  ['anonymous on a mature domain', null, true, PG],
  ['anonymous on the SFW domain', null, false, PG],
  ['signed in on the SFW domain', nsfwUser, false, SFW],
  ['signed in on a mature domain', nsfwUser, true, ALL_SELECTABLE],
  ['signed in with NSFW off on a mature domain', nsfwOffUser, true, PG],
] as const;

describe('getRequestBrowsingLevel', () => {
  it.each(viewers)('%s', (_label, user, canViewNsfw, expected) => {
    expect(
      getRequestBrowsingLevel({
        features: { canViewNsfw } as Parameters<typeof getRequestBrowsingLevel>[0]['features'],
        user: user ?? undefined,
      } as Parameters<typeof getRequestBrowsingLevel>[0])
    ).toBe(expected);
  });

  it('an unresolved flag (sparse undefined) is treated as the SFW domain', () => {
    expect(
      getRequestBrowsingLevel({ features: {}, user: nsfwUser } as unknown as Parameters<
        typeof getRequestBrowsingLevel
      >[0])
    ).toBe(SFW);
  });
});

function makeReq(query: Record<string, string>) {
  return { method: 'GET', headers: {}, query } as unknown as NextApiRequest;
}
function makeRes() {
  const res = {
    status: () => res,
    json: () => res,
    setHeader: () => res,
    headersSent: false,
  } as unknown as NextApiResponse;
  return res;
}
type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

const routes = [
  [
    '/api/generation/resources',
    generationResourcesHandler as unknown as Handler,
    { ids: '1' },
    () => mockGetResourceData.mock.calls[0]?.[1]?.browsingLevel,
  ],
  [
    '/api/generation/data',
    generationDataHandler as unknown as Handler,
    { type: 'modelVersion', id: '1', withPreview: 'true' },
    () => mockGetGenerationData.mock.calls[0]?.[0]?.browsingLevel,
  ],
] as const;

beforeEach(() => {
  mockSession.mockReset();
  mockGetResourceData.mockReset().mockResolvedValue([]);
  mockGetGenerationData.mockReset().mockResolvedValue({});
  mockFeatureFlagsLazy.mockReset();
});

describe.each(routes)(
  '%s resolves the preview level per request',
  (_route, handler, query, level) => {
    it.each(viewers)('%s', async (_label, user, canViewNsfw, expected) => {
      mockSession.mockResolvedValue(user ? { user } : null);
      mockFeatureFlagsLazy.mockReturnValue({ canViewNsfw });
      const req = makeReq(query);

      await handler(req, makeRes());

      // The domain half of the level is only correct if the flags were read for THIS request.
      expect(mockFeatureFlagsLazy).toHaveBeenCalledWith({ user: user ?? undefined, req });
      expect(level()).toBe(expected);
    });
  }
);
