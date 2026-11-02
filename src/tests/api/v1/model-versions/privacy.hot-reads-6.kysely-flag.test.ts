import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';

/**
 * The metric-privacy read of `prepareModelVersionResponse` (GET /api/v1/model-versions/[id] and
 * the by-hash routes) behind `kysely-hot-reads-6`. OFF: the Prisma read on the replica. ON: the
 * Kysely read on the replica, whose row alone decides: its version `meta` hides downloads and its
 * owner is the one whose membership is checked (the Prisma stub would hide nothing and name
 * another owner).
 */

const { mockMembership } = vi.hoisted(() => ({ mockMembership: vi.fn() }));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads6>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
vi.mock('~/server/services/model.service', () => ({
  getVaeFiles: async () => [],
  // These suites cover other behaviour; the hold has its own.
  holdShowcaseImages: async (byVersion: unknown) => byVersion,
}));
vi.mock('~/server/services/image.service', () => ({ getImagesForModelVersion: async () => [] }));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: async () => ({}),
  toPublicPaidAccessDto: () => null,
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  hasValidCreatorMembershipCached: mockMembership,
}));
vi.mock('~/server/services/file.service', () => ({
  getDownloadFilename: ({ file }: { file: { id: number } }) => `${file.id}.safetensors`,
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint: (handler: unknown) => handler,
  PublicEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => 'US',
  isRegionRestricted: () => false,
}));

import * as queries from '@civitai/db-queries/hot-reads-6';
import { kyselyRead } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';

const flag = vi.mocked(isFlipt);
// `~/server/db/client` is the canonical shared mock (src/__tests__/mocks/db.mock.ts).
const mockFindUnique = dbMock.dbRead.modelVersion.findUnique;
const q = vi.mocked(queries);
const FLAG = 'kysely-hot-reads-6';
const VERSION = 9242;
const OFF_OWNER = 9307;
const ON_OWNER = 9308;

function modelVersion() {
  return {
    id: VERSION,
    modelId: 9277,
    name: 'v1',
    baseModel: 'SD 1.5',
    status: 'Published',
    availability: 'Public',
    nsfwLevel: 1,
    licensingFee: null,
    files: [
      {
        id: 9221,
        type: 'Model',
        visibility: 'Public',
        sizeKB: 1111,
        modelVersionId: VERSION,
        url: 's3://a',
        name: 'a.safetensors',
        hashes: [{ type: 'SHA256', hash: 'aaaa1111' }],
        metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
      },
    ],
    metrics: [{ downloadCount: 5, thumbsUpCount: 2 }],
    model: {
      name: 'Model',
      type: 'Checkpoint',
      nsfw: false,
      poi: false,
      mode: null,
      availability: 'Public',
      userId: 9999,
    },
  } as never;
}

const prepare = async () =>
  (await import('~/pages/api/v1/model-versions/[id]')).prepareModelVersionResponse(
    modelVersion(),
    new URL('https://civitai.com'),
    [],
    null
  );

beforeEach(() => {
  vi.clearAllMocks();
  flag.mockReset().mockResolvedValue(false);
  q.getModelVersionPrivacyRow.mockReset();
  mockMembership.mockReset().mockResolvedValue(true);
  mockFindUnique.mockReset().mockResolvedValue({
    meta: {},
    model: { meta: {}, userId: OFF_OWNER, user: { settings: {} } },
  });
});

describe('prepareModelVersionResponse (the metric-privacy inputs)', () => {
  it('OFF: the Prisma read on the replica, which hides nothing', async () => {
    const body = await prepare();
    expect(body!.stats.downloadCount).toBe(5);
    expect(flag.mock.calls.filter(([key]) => key === FLAG)).toEqual([[FLAG]]);
    expect(mockFindUnique.mock.calls[0][0]).toEqual({
      where: { id: VERSION },
      select: {
        meta: true,
        model: { select: { meta: true, userId: true, user: { select: { settings: true } } } },
      },
    });
    expect(q.getModelVersionPrivacyRow).not.toHaveBeenCalled();
    expect(mockMembership).not.toHaveBeenCalled();
  });

  it('ON: the Kysely read on the replica, whose meta hides downloads for its owner', async () => {
    flag.mockImplementation(async (key) => key === FLAG);
    q.getModelVersionPrivacyRow.mockResolvedValue({
      meta: { hideDownloads: true },
      modelRowId: 9277,
      modelMeta: {},
      modelUserId: ON_OWNER,
      userRowId: ON_OWNER,
      userSettings: {},
    } as never);
    const body = await prepare();
    expect(body!.stats.downloadCount).toBeNull();
    expect(mockMembership.mock.calls).toEqual([[ON_OWNER]]);
    expect(q.getModelVersionPrivacyRow.mock.calls).toEqual([[kyselyRead, VERSION]]);
    expect(q.getModelVersionPrivacyRow.mock.calls[0][0]).toBe(kyselyRead);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('ON: an orphaned row runs the Prisma read instead', async () => {
    flag.mockImplementation(async (key) => key === FLAG);
    q.getModelVersionPrivacyRow.mockResolvedValue({
      meta: { hideDownloads: true },
      modelRowId: null,
      modelMeta: null,
      modelUserId: null,
      userRowId: null,
      userSettings: null,
    } as never);
    const body = await prepare();
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
    expect(body!.stats.downloadCount).toBe(5);
  });
});
