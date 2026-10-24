import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelVersionTerms } from '@civitai/buzz';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The paid generation gate END TO END, over the real `getResourceData` and the real
 * `applyPaidAccessGating`, on an expansion-covered version (live rule false, staged rule true).
 *
 * That shape is the one the substitute search matches against itself, so the request carries the
 * version twice: once as asked for and once as its own substitute candidate.
 */

const { mockIsFlipt, mockFetch, mockFindMany, mockGetPaidAccess, mockHasEntityAccess } = vi.hoisted(
  () => ({
    mockIsFlipt: vi.fn(),
    mockFetch: vi.fn(),
    mockFindMany: vi.fn(),
    mockGetPaidAccess: vi.fn(),
    mockHasEntityAccess: vi.fn(),
  })
);

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mockIsFlipt,
}));
vi.mock('~/server/redis/resource-data.redis', () => ({
  resourceDataCache: { fetch: mockFetch, bust: vi.fn() },
}));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(async () => ({ modelVersion: { findMany: mockFindMany } })),
}));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn(async () => []) }));
vi.mock('~/server/services/model-file.service', () => ({
  getFilesForModelVersionCache: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getViewerMonetization: vi.fn(async ({ versions }: { versions: { id: number }[] }) =>
    Object.fromEntries(
      versions.map((v) => [v.id, { paidAccess: mockGetPaidAccess()[v.id], sale: null }])
    )
  ),
}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: mockHasEntityAccess }));
vi.mock('~/server/services/generation/version-generation-state.service', () => ({
  getVisibleSystemWildcardSetIdsByVersionId: vi.fn(async () => new Map()),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

import { getResourceData } from '~/server/services/generation/generation.service';

const VERSION_ID = 5150;
const MODEL_ID = 99;
const OWNER = 777;

const BUNDLED: ModelVersionTerms = { download: { price: 500 } }; // no generation key = must buy
const TRIAL: ModelVersionTerms = {
  download: { price: 500 },
  generation: { price: 200, trialLimit: 5 },
};
const FREE: ModelVersionTerms = { generation: { free: true } };

const row = (over: Record<string, unknown> = {}) => ({
  id: VERSION_ID,
  name: 'v1',
  trainedWords: [],
  clipSkip: null,
  vaeId: null,
  baseModel: 'SDXL 1.0',
  settings: null,
  availability: 'Public',
  aliasId: null,
  covered: false,
  coveredNext: true,
  generatorLoaded: false,
  status: 'Published',
  usageControl: 'Download',
  flags: 0,
  hasAccess: true,
  model: {
    id: MODEL_ID,
    name: 'A Model',
    type: 'Checkpoint',
    nsfw: false,
    poi: false,
    userId: OWNER,
  },
  ...over,
});

const gate = (terms: ModelVersionTerms) => ({
  entityType: 'ModelVersion' as const,
  entityId: VERSION_ID,
  ownerId: OWNER,
  endsAt: new Date('2099-01-01T00:00:00.000Z'),
  timeframeDays: 7,
  terms,
});

const BRONZE = { id: 2, tier: 'bronze' };
const MOD = { id: 4, isModerator: true, tier: 'free' };

/**
 * Stands in for the substitute query: every Published version of the model the staged rule covers,
 * which here is the requested version itself. It honours an `id.notIn` exclusion, so a fix that
 * excludes the version is exercised rather than asserted.
 */
function withCandidates(data: ReturnType<typeof row>) {
  mockFetch.mockImplementation(async (ids: number[]) =>
    ids.includes(data.id) ? [{ ...data, model: { ...data.model } }] : []
  );
  mockFindMany.mockImplementation(
    async ({ where }: { where: { id?: { notIn?: number[] }; modelId: { in: number[] } } }) =>
      where.modelId.in.includes(data.model.id) && !where.id?.notIn?.includes(data.id)
        ? [{ id: data.id, baseModel: data.baseModel, modelId: data.model.id }]
        : []
  );
}

async function resolve(user: Record<string, unknown>, data = row()) {
  withCandidates(data);
  const [resource] = await getResourceData([VERSION_ID], { user, generation: true });
  return resource;
}

beforeEach(() => {
  vi.clearAllMocks();
  // coverage-next ON, open-to-all OFF.
  mockIsFlipt.mockImplementation(async (flag: string) => flag === 'generation-coverage-next');
  mockGetPaidAccess.mockReturnValue({});
  mockHasEntityAccess.mockResolvedValue([]);
});

describe('getResourceData gates a paid expansion-covered version', () => {
  it('refuses a non-buyer member a must-buy version', async () => {
    mockGetPaidAccess.mockReturnValue({ [VERSION_ID]: gate(BUNDLED) });

    const resource = await resolve(BRONZE);

    expect(resource?.hasAccess).toBe(false);
    expect(resource?.canGenerate).toBe(false);
  });

  /** The positive control: the live rule covers it, so it never becomes its own substitute. */
  it('refuses a non-buyer member the same version when the live rule covers it', async () => {
    mockGetPaidAccess.mockReturnValue({ [VERSION_ID]: gate(BUNDLED) });

    const resource = await resolve(BRONZE, row({ covered: true }));

    expect(resource?.hasAccess).toBe(false);
    expect(resource?.canGenerate).toBe(false);
  });

  it('allows a member who bought it', async () => {
    mockGetPaidAccess.mockReturnValue({ [VERSION_ID]: gate(BUNDLED) });
    mockHasEntityAccess.mockResolvedValue([{ entityId: VERSION_ID, hasAccess: true }]);

    const resource = await resolve(BRONZE);

    expect(resource?.hasAccess).toBe(true);
    expect(resource?.canGenerate).toBe(true);
  });

  it.each([
    ['a trial', TRIAL],
    ['free generation', FREE],
  ])('allows a non-buyer member on %s', async (_name, terms) => {
    mockGetPaidAccess.mockReturnValue({ [VERSION_ID]: gate(terms) });

    const resource = await resolve(BRONZE);

    expect(resource?.canGenerate).toBe(true);
  });

  it.each([
    ['owner', { id: OWNER, tier: 'bronze' }],
    ['moderator', MOD],
  ])('allows the %s', async (_name, user) => {
    mockGetPaidAccess.mockReturnValue({ [VERSION_ID]: gate(BUNDLED) });

    const resource = await resolve(user);

    expect(resource?.canGenerate).toBe(true);
  });
});

describe('getResourceData substitutes', () => {
  it('never offers a version as its own substitute', async () => {
    const resource = await resolve(BRONZE);

    expect(resource?.canGenerate).toBe(true);
    expect(resource?.substitute).toBeUndefined();
  });
});
