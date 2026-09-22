import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

const { mockSession, mockGetResourceData, mockGetGenerationData, mockCanViewNsfw } = vi.hoisted(
  () => ({
    mockSession: vi.fn(),
    mockGetResourceData: vi.fn(),
    mockGetGenerationData: vi.fn(),
    mockCanViewNsfw: vi.fn(),
  })
);

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
  getFeatureFlags: () => ({ canViewNsfw: mockCanViewNsfw() }),
}));

import generationDataHandler from '~/pages/api/generation/data';
import generationResourcesHandler from '~/pages/api/generation/resources';

const PG = 1;
const SFW = 1 | 2;
const ALL_SELECTABLE = 1 | 2 | 4 | 8 | 16;

function call(handler: unknown, query: Record<string, string>) {
  const req = { method: 'GET', headers: {}, query } as unknown as NextApiRequest;
  const res = {
    status: () => res,
    json: () => res,
    setHeader: () => res,
    headersSent: false,
  } as unknown as NextApiResponse;
  return (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(req, res);
}

const nsfwUser = { id: 5, showNsfw: true, browsingLevel: ALL_SELECTABLE };

beforeEach(() => {
  mockSession.mockReset();
  mockGetResourceData.mockReset().mockResolvedValue([]);
  mockGetGenerationData.mockReset().mockResolvedValue({});
  mockCanViewNsfw.mockReset();
});

describe('generator preview endpoints resolve the viewer browsing level', () => {
  it.each([
    ['anonymous on a mature domain', null, true, PG],
    ['anonymous on the SFW domain', null, false, PG],
    ['signed in on the SFW domain', nsfwUser, false, SFW],
    ['signed in on a mature domain', nsfwUser, true, ALL_SELECTABLE],
  ])('/api/generation/resources: %s', async (_label, user, canViewNsfw, expected) => {
    mockSession.mockResolvedValue(user ? { user } : null);
    mockCanViewNsfw.mockReturnValue(canViewNsfw);

    await call(generationResourcesHandler, { ids: '1' });

    expect(mockGetResourceData).toHaveBeenCalledTimes(1);
    expect(mockGetResourceData.mock.calls[0][1].browsingLevel).toBe(expected);
  });

  it('/api/generation/data: anonymous on a mature domain gets PG', async () => {
    mockSession.mockResolvedValue(null);
    mockCanViewNsfw.mockReturnValue(true);

    await call(generationDataHandler, { type: 'modelVersion', id: '1', withPreview: 'true' });

    expect(mockGetGenerationData).toHaveBeenCalledTimes(1);
    expect(mockGetGenerationData.mock.calls[0][0].browsingLevel).toBe(PG);
  });
});
