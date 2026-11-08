import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as VersionChildrenService from '~/server/services/model-version-generation-children.service';
import type * as PaidAccessService from '~/server/services/paid-access.service';

const { mockGetVersionById } = vi.hoisted(() => ({ mockGetVersionById: vi.fn() }));

// The controller reaches the orchestrator caller through training.service, which throws on a
// missing token at import. Nothing on this path calls it.
vi.mock('~/server/services/training.service', () => ({}));
vi.mock('~/server/services/model-version-generation-children.service', async (importOriginal) => ({
  ...(await importOriginal<typeof VersionChildrenService>()),
  getVersionByIdWithGenerationChildren: mockGetVersionById,
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: vi.fn(async () => []),
  resolveCanGenerateForVersions: vi.fn(async () => new Map()),
}));
vi.mock('~/server/services/generation/coverage-source', () => ({
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
  coveragePairForUser: vi.fn(() => ({})),
}));
vi.mock('~/server/services/paid-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PaidAccessService>()),
  getViewerMonetization: vi.fn(async () => ({
    100: { paidAccess: null, licensingFee: null, sale: null },
  })),
}));
vi.mock('~/server/services/creator-membership.service', () => ({
  getOwnerMetricPrivacyDefaultsForEditor: vi.fn(async () => null),
}));

import { getModelVersionHandler } from '~/server/controllers/model-version.controller';
import { ModelVersionFlag } from '~/shared/constants/model-version-flags.constants';

const { PartnerService, PartnerTrains, NotEvictable } = ModelVersionFlag;
const STORED = PartnerService | PartnerTrains | NotEvictable;

async function servedFlags(user: { id: number; isModerator: boolean } | undefined) {
  mockGetVersionById.mockResolvedValue({
    id: 100,
    status: 'Published',
    flags: STORED,
    recommendedResources: [],
    model: { id: 1, poi: false, type: 'LORA', meta: null, user: { id: 7 } },
  });
  const version = await getModelVersionHandler({
    input: { id: 100 },
    ctx: { user, features: {} },
  } as never);
  return (version as { flags?: number }).flags;
}

beforeEach(() => vi.clearAllMocks());

describe('modelVersion.getById flags', () => {
  it.each([
    ['anonymous', undefined],
    ['a signed-in non-moderator', { id: 9, isModerator: false }],
    ['the owner', { id: 7, isModerator: false }],
  ])('%s gets the flags without the partner bits', async (_, user) => {
    expect(await servedFlags(user)).toBe(NotEvictable);
  });

  it('a moderator gets the stored value, which the version menu reads', async () => {
    expect(await servedFlags({ id: 1, isModerator: true })).toBe(STORED);
  });
});
