import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads from '@civitai/db-queries/hot-reads';
import type * as LagHelpers from '~/server/db/db-lag-helpers';

// The Kysely/Prisma switch. FLIPT_FEATURE_FLAGS stays real, so the key asserted below is the one
// production evaluates.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read query stubbed: their rows against Prisma's are compared in
// hot-reads-2.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// The lag decision, so a test can make it pick the primary and see both paths follow it.
const { getDbWithoutLag, getKyselyWithoutLag } = vi.hoisted(() => ({
  getDbWithoutLag: vi.fn(),
  getKyselyWithoutLag: vi.fn(),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof LagHelpers>()),
  getDbWithoutLag,
  getKyselyWithoutLag,
}));

import * as queries from '@civitai/db-queries/hot-reads';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';
import { modelWithDetailsSelect } from '~/server/selectors/model.selector';
import { getModel } from '~/server/services/model.service';

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);

// Pairwise distinct, and distinct from every count below.
const MODEL = 8101;
const OWNER = 8202;
const VERSION = 8303;
const FILE = 8404;
const RESOURCE = 8505;
const RECOMMENDATION = 8606;

const UPDATED = new Date('2026-10-01T10:11:12.345Z');
const SCANNED = new Date('2026-10-02T01:02:03.456Z');

const prismaModel = {
  id: MODEL,
  name: 'model',
  status: 'Published',
  allowCommercialUse: ['Image', 'Sell'],
  updatedAt: UPDATED,
  meta: { a: 1 },
  licenses: [{ id: 3, name: 'MIT', url: 'https://example.com/mit' }],
  reportStats: { ownershipProcessing: 2 },
  user: {
    id: OWNER,
    image: null,
    username: 'creator',
    deletedAt: null,
    rank: { leaderboardRank: 7 },
  },
  modelVersions: [
    {
      id: VERSION,
      modelId: MODEL,
      licensingFee: new Prisma.Decimal('12.5'),
      metrics: [
        {
          generationCount: 11,
          downloadCount: 12,
          thumbsUpCount: 13,
          thumbsDownCount: 14,
          earnedAmount: 15,
        },
      ],
      files: [
        {
          id: FILE,
          scannedAt: SCANNED,
          modelVersionId: VERSION,
          hashes: [{ type: 'SHA256', hash: 'abc' }],
        },
      ],
      generationCoverage: { covered: true, coveredNext: false },
      recommendedResources: [
        { id: RECOMMENDATION, resource: { id: RESOURCE }, settings: { strength: 1 } },
      ],
    },
  ],
  metrics: [{ downloadCount: 21, commentCount: 22 }],
};

/** The same facts as Kysely rows, so a difference in the answer is the port's. */
function givenBothPaths() {
  dbMock.dbRead.model.findFirst.mockResolvedValue(prismaModel);
  q.getModelWithDetailsRow.mockResolvedValue({
    id: MODEL,
    name: 'model',
    status: 'Published',
    allowCommercialUse: ['Image', 'Sell'],
    updatedAt: UPDATED,
    meta: { a: 1 },
    licenses: [{ id: 3, name: 'MIT', url: 'https://example.com/mit' }],
    reportStats: { ownershipProcessing: 2 },
    userId: OWNER,
    userImage: null,
    userUsername: 'creator',
    userDeletedAt: null,
    rankUserId: OWNER,
    rankLeaderboardRank: 7,
    metrics: [{ downloadCount: 21, commentCount: 22 }],
  } as never);
  q.listModelWithDetailsVersions.mockResolvedValue([
    {
      id: VERSION,
      modelId: MODEL,
      licensingFee: '12.50',
      metrics: [
        {
          generationCount: 11,
          downloadCount: 12,
          thumbsUpCount: 13,
          thumbsDownCount: 14,
          earnedAmount: 15,
        },
      ],
      recommendedResources: [
        { id: RECOMMENDATION, resourceId: RESOURCE, settings: { strength: 1 } },
      ],
    },
  ] as never);
  q.listModelGenerationCoverage.mockResolvedValue([
    { modelVersionId: VERSION, covered: true, coveredNext: false },
  ] as never);
  q.listModelWithDetailsFiles.mockResolvedValue([
    {
      id: FILE,
      scannedAt: SCANNED,
      modelVersionId: VERSION,
      hashes: [{ type: 'SHA256', hash: 'abc' }],
    },
  ] as never);
}

const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

// The ONE connection each client hands out (`db.connection().execute(cb)`), as a distinct object
// per client, so "every statement ran on that client's single connection" is checkable.
const pinnedRead = { pinned: 'read' };
const pinnedWrite = { pinned: 'write' };
const readConnection = vi.spyOn(kyselyRead, 'connection');
const writeConnection = vi.spyOn(kyselyWrite, 'connection');
const pin = (conn: object) => ({ execute: (cb: (c: unknown) => unknown) => cb(conn) } as never);
const STATEMENTS = () => [
  q.getModelWithDetailsRow,
  q.listModelWithDetailsVersions,
  q.listModelGenerationCoverage,
  q.listModelWithDetailsFiles,
];

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  getDbWithoutLag.mockReset().mockResolvedValue(dbMock.dbRead);
  getKyselyWithoutLag.mockReset().mockResolvedValue(kyselyRead);
  readConnection.mockReset().mockImplementation(() => pin(pinnedRead));
  writeConnection.mockReset().mockImplementation(() => pin(pinnedWrite));
});

const modelPage = () => getModel({ id: MODEL, select: modelWithDetailsSelect });

describe('getModel with modelWithDetailsSelect (the model page)', () => {
  it('control: the routing checks below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });

  it('evaluates kysely-hot-reads-2 by key, with no entity or context', async () => {
    givenBothPaths();
    await modelPage();
    expect(flag.mock.calls).toEqual([['kysely-hot-reads-2']]);
  });

  it('OFF: reads through Prisma only, on the client the lag decision picked', async () => {
    givenBothPaths();
    await expect(modelPage()).resolves.toBe(prismaModel);
    expect(getDbWithoutLag).toHaveBeenCalledWith('model', MODEL);
    expect(dbMock.dbRead.model.findFirst).toHaveBeenCalledWith({
      where: { id: MODEL },
      select: modelWithDetailsSelect,
    });
    expect(getKyselyWithoutLag).not.toHaveBeenCalled();
    for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
  });

  it('ON: reads the same model through Kysely only, in the Prisma shape', async () => {
    givenBothPaths();
    flag.mockResolvedValue(true);
    const model = await modelPage();
    expect(model).toEqual(prismaModel);
    expect(dbMock.dbRead.model.findFirst).not.toHaveBeenCalled();
    expect(getDbWithoutLag).not.toHaveBeenCalled();
    // Every statement on the read client's ONE connection, taken once per model page.
    expect(readConnection).toHaveBeenCalledTimes(1);
    expect(writeConnection).not.toHaveBeenCalled();
    expect(q.getModelWithDetailsRow.mock.calls).toEqual([[pinnedRead, MODEL]]);
    expect(q.listModelWithDetailsVersions.mock.calls).toEqual([[pinnedRead, MODEL]]);
    expect(q.listModelGenerationCoverage.mock.calls).toEqual([[pinnedRead, MODEL]]);
    // Files by the version ids the versions statement returned, as the Prisma relation read does.
    expect(q.listModelWithDetailsFiles.mock.calls).toEqual([[pinnedRead, [VERSION]]]);
    for (const read of STATEMENTS()) expect(read.mock.calls[0][0]).toBe(pinnedRead);
    // A Decimal, as Prisma returns it, not the text the query reads it as.
    expect(model?.modelVersions[0].licensingFee).toBeInstanceOf(Prisma.Decimal);
  });

  it('ON: follows the lag decision to the primary, as the Prisma read does', async () => {
    givenBothPaths();
    flag.mockResolvedValue(true);
    getKyselyWithoutLag.mockResolvedValue(kyselyWrite);
    await modelPage();
    expect(getKyselyWithoutLag).toHaveBeenCalledWith('model', MODEL);
    expect(writeConnection).toHaveBeenCalledTimes(1);
    expect(readConnection).not.toHaveBeenCalled();
    for (const read of STATEMENTS()) expect(read.mock.calls[0][0]).toBe(pinnedWrite);
  });

  it('ON: a missing model is null, as findFirst returns', async () => {
    givenBothPaths();
    flag.mockResolvedValue(true);
    q.getModelWithDetailsRow.mockResolvedValue(undefined);
    await expect(modelPage()).resolves.toBeNull();
    // Nothing after the first statement.
    expect(q.listModelWithDetailsVersions).not.toHaveBeenCalled();
    expect(q.listModelWithDetailsFiles).not.toHaveBeenCalled();
  });
});

describe('getModel with any other select', () => {
  it('stays on Prisma with the flag on, and does not evaluate it', async () => {
    flag.mockResolvedValue(true);
    dbMock.dbRead.model.findFirst.mockResolvedValue({ id: MODEL });
    await expect(getModel({ id: MODEL, select: { id: true } })).resolves.toEqual({ id: MODEL });
    expect(dbMock.dbRead.model.findFirst).toHaveBeenCalledWith({
      where: { id: MODEL },
      select: { id: true },
    });
    expect(flag).not.toHaveBeenCalled();
    for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
  });
});
