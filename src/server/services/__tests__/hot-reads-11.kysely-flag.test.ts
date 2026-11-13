import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads11 from '@civitai/db-queries/hot-reads-11';

// The Kysely/Prisma switch, read synchronously. FLIPT_FEATURE_FLAGS stays real, so the key asserted
// below is the one production evaluates. A client exists, so the gate never starts Flipt itself.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: vi.fn(),
  getFliptClientSync: vi.fn(() => ({})),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));
// The one statement stubbed: its rows against Prisma's are compared in
// hot-reads-11.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-11', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads11>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});

import * as queries from '@civitai/db-queries/hot-reads-11';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFliptSync } from '~/server/flipt/client';
import {
  readModelsWithVersionsStats,
  resetHotReads11GateForTests,
} from '~/server/services/hot-reads-11.reads';

/**
 * `readModelsWithVersionsStats` (getModelsWithVersions' four per-page reads) behind
 * `kysely-hot-reads-11`: the flag is evaluated by its key, with no entity or context; OFF reads
 * through the four Prisma reads on the replica, with the arguments they always had; ON reads
 * through the one Kysely statement on the replica client and returns values that can only have
 * come from the Kysely row (the ON fixture differs from the OFF one). A missing key or a failing
 * read is OFF. Row parity against a real database is in hot-reads-11.kysely-parity.test.ts.
 */

const flag = vi.mocked(isFliptSync);
const row = vi.mocked(queries.getModelsWithVersionsStatsRow);
const FLAG = 'kysely-hot-reads-11';

// Pairwise distinct, and distinct from every counter below.
const MODEL = 13101;
const MODEL_2 = 13102;
const VERSION = 13201;
const VERSION_2 = 13202;
const VAE = 13301;

const IDS = { modelIds: [MODEL, MODEL_2], modelVersionIds: [VERSION, VERSION_2] };

const primePrisma = () => {
  dbMock.dbRead.recommendedResource.findMany.mockResolvedValue([
    { sourceId: VERSION, resourceId: VAE, settings: { from: 'prisma' } },
  ] as never);
  dbMock.dbRead.modelMetric.findMany.mockResolvedValue([
    {
      modelId: MODEL,
      downloadCount: 13401,
      thumbsUpCount: 13402,
      thumbsDownCount: 13403,
      commentCount: 13404,
      tippedAmountCount: 13405,
    },
  ] as never);
  dbMock.dbRead.modelVersionMetric.findMany.mockResolvedValue([
    { modelVersionId: VERSION, downloadCount: 13501, thumbsUpCount: 13502, thumbsDownCount: 13503 },
  ] as never);
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
    { id: VERSION, meta: { from: 'prisma' } },
  ] as never);
};

const prismaReads = () => [
  dbMock.dbRead.recommendedResource.findMany,
  dbMock.dbRead.modelMetric.findMany,
  dbMock.dbRead.modelVersionMetric.findMany,
  dbMock.dbRead.modelVersion.findMany,
];

const KYSELY_ROW = {
  vaeLinks: [{ sourceId: VERSION_2, resourceId: VAE, settings: { from: 'kysely' } }],
  modelMetrics: [
    {
      modelId: MODEL_2,
      downloadCount: 13601,
      thumbsUpCount: 13602,
      thumbsDownCount: 13603,
      commentCount: 13604,
      tippedAmountCount: 13605,
    },
  ],
  versionMetrics: [
    {
      modelVersionId: VERSION_2,
      downloadCount: 13701,
      thumbsUpCount: 13702,
      thumbsDownCount: 13703,
    },
  ],
  versionMeta: [{ id: VERSION_2, meta: { from: 'kysely' } }],
};

beforeEach(() => {
  resetSharedMocks();
  resetHotReads11GateForTests();
  row.mockReset();
  flag.mockReset().mockReturnValue(false);
});

describe('control', () => {
  it('the routing check below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });
});

describe('readModelsWithVersionsStats', () => {
  it('OFF: the four Prisma reads on the replica, with their original arguments', async () => {
    primePrisma();
    await expect(readModelsWithVersionsStats(IDS)).resolves.toEqual({
      vaeLinkedRows: [{ sourceId: VERSION, resourceId: VAE, settings: { from: 'prisma' } }],
      metrics: [
        {
          modelId: MODEL,
          downloadCount: 13401,
          thumbsUpCount: 13402,
          thumbsDownCount: 13403,
          commentCount: 13404,
          tippedAmountCount: 13405,
        },
      ],
      versionMetrics: [
        {
          modelVersionId: VERSION,
          downloadCount: 13501,
          thumbsUpCount: 13502,
          thumbsDownCount: 13503,
        },
      ],
      versionMetaRows: [{ id: VERSION, meta: { from: 'prisma' } }],
    });
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(dbMock.dbRead.recommendedResource.findMany.mock.calls).toEqual([
      [
        {
          where: {
            sourceId: { in: [VERSION, VERSION_2] },
            settings: { path: ['isLinkedComponent'], equals: true },
          },
          select: { sourceId: true, resourceId: true, settings: true },
        },
      ],
    ]);
    expect(dbMock.dbRead.modelMetric.findMany.mock.calls).toEqual([
      [{ where: { modelId: { in: [MODEL, MODEL_2] } } }],
    ]);
    expect(dbMock.dbRead.modelVersionMetric.findMany.mock.calls).toEqual([
      [{ where: { modelVersionId: { in: [VERSION, VERSION_2] } } }],
    ]);
    expect(dbMock.dbRead.modelVersion.findMany.mock.calls).toEqual([
      [{ where: { id: { in: [VERSION, VERSION_2] } }, select: { id: true, meta: true } }],
    ]);
    expect(row).not.toHaveBeenCalled();
  });

  it('OFF with no versions: the two version-keyed reads are skipped, as before', async () => {
    primePrisma();
    await readModelsWithVersionsStats({ modelIds: [MODEL], modelVersionIds: [] });
    expect(dbMock.dbRead.recommendedResource.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbRead.modelVersion.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbRead.modelMetric.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.modelVersionMetric.findMany).toHaveBeenCalledTimes(1);
  });

  it('ON: one Kysely statement on the replica, whose rows are the result', async () => {
    flag.mockReturnValue(true);
    primePrisma();
    row.mockResolvedValue(KYSELY_ROW as never);
    await expect(readModelsWithVersionsStats(IDS)).resolves.toEqual({
      vaeLinkedRows: [{ sourceId: VERSION_2, resourceId: VAE, settings: { from: 'kysely' } }],
      metrics: [
        {
          modelId: MODEL_2,
          downloadCount: 13601,
          thumbsUpCount: 13602,
          thumbsDownCount: 13603,
          commentCount: 13604,
          tippedAmountCount: 13605,
        },
      ],
      versionMetrics: [
        {
          modelVersionId: VERSION_2,
          downloadCount: 13701,
          thumbsUpCount: 13702,
          thumbsDownCount: 13703,
        },
      ],
      versionMetaRows: [{ id: VERSION_2, meta: { from: 'kysely' } }],
    });
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(row.mock.calls).toEqual([[kyselyRead, IDS]]);
    expect(row.mock.calls[0][0]).toBe(kyselyRead);
    for (const read of prismaReads()) expect(read).not.toHaveBeenCalled();
  });

  it('ON with nothing requested: no statement at all', async () => {
    flag.mockReturnValue(true);
    await expect(
      readModelsWithVersionsStats({ modelIds: [], modelVersionIds: [] })
    ).resolves.toEqual({ vaeLinkedRows: [], metrics: [], versionMetrics: [], versionMetaRows: [] });
    expect(row).not.toHaveBeenCalled();
    for (const read of prismaReads()) expect(read).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    ['a missing key (null)', () => flag.mockReturnValue(null)],
    [
      'a throwing read',
      () =>
        flag.mockImplementation(() => {
          throw new Error('flipt down');
        }),
    ],
  ])('%s reads as OFF', async (_, arrange) => {
    arrange();
    primePrisma();
    await readModelsWithVersionsStats(IDS);
    expect(flag).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.modelMetric.findMany).toHaveBeenCalledTimes(1);
    expect(row).not.toHaveBeenCalled();
  });

  it('the flag is read once per refresh window, not once per call', async () => {
    flag.mockReturnValue(true);
    row.mockResolvedValue(KYSELY_ROW as never);
    await readModelsWithVersionsStats(IDS);
    await readModelsWithVersionsStats(IDS);
    expect(flag).toHaveBeenCalledTimes(1);
    expect(row).toHaveBeenCalledTimes(2);
  });
});
