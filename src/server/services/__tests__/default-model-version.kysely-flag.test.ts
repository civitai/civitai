import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads3 from '@civitai/db-queries/hot-reads-3';
import type * as LagHelpers from '~/server/db/db-lag-helpers';

// The Kysely/Prisma switch. FLIPT_FEATURE_FLAGS stays real, so the key asserted below is the one
// production evaluates.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read-3 statement stubbed: their rows against Prisma's are compared in
// hot-reads-3.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-3', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads3>();
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

import * as queries from '@civitai/db-queries/hot-reads-3';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';
import { getDefaultModelVersion } from '~/server/services/model-version.service';

/**
 * The model page's default-version lookup (`getDefaultModelVersion`) behind `kysely-hot-reads-3`:
 * which client each path reads, and that the Kysely rows reach the caller's logic in the Prisma
 * shape. Row parity against a real database is in hot-reads-3.kysely-parity.test.ts.
 */

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

// Pairwise distinct.
const MODEL = 7101;
const OWNER = 7202;
const VERSION = 7303;
const OTHER_VIEWER = 7404;
const PUBLISHED = new Date('2026-09-01T02:03:04.567Z');

const prismaResult = {
  modelVersions: [
    {
      id: VERSION,
      status: 'Published',
      publishedAt: PUBLISHED,
      model: { id: MODEL, userId: OWNER, availability: 'Public', status: 'Published' },
      availability: 'Public',
      trainingStatus: null,
    },
  ],
};

function givenBothPaths() {
  dbMock.dbRead.model.findUnique.mockResolvedValue(prismaResult);
  dbMock.dbWrite.model.findUnique.mockResolvedValue(prismaResult);
  q.listDefaultModelVersionRows.mockResolvedValue([
    {
      modelId: MODEL,
      modelUserId: OWNER,
      modelAvailability: 'Public',
      modelStatus: 'Published',
      versionId: VERSION,
      versionStatus: 'Published',
      versionPublishedAt: PUBLISHED,
      versionAvailability: 'Public',
      versionTrainingStatus: null,
    },
  ] as never);
}

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  getDbWithoutLag.mockReset().mockResolvedValue(dbMock.dbRead);
  getKyselyWithoutLag.mockReset().mockResolvedValue(kyselyRead);
});

const lookup = (modelVersionId?: number) =>
  getDefaultModelVersion({ modelId: MODEL, modelVersionId, userId: OTHER_VIEWER });

describe('getDefaultModelVersion (the model page default version)', () => {
  it('control: the routing checks below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });

  it('evaluates kysely-hot-reads-3 by key, with no entity or context', async () => {
    givenBothPaths();
    await lookup();
    expect(flag.mock.calls).toEqual([['kysely-hot-reads-3']]);
  });

  it('OFF: reads through Prisma only, on the client the lag decision picked', async () => {
    givenBothPaths();
    await expect(lookup(VERSION)).resolves.toBe(prismaResult.modelVersions[0]);
    expect(getDbWithoutLag).toHaveBeenCalledWith('model', MODEL);
    expect(dbMock.dbRead.model.findUnique).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.model.findUnique.mock.calls[0][0]).toMatchObject({
      where: { id: MODEL },
      select: { modelVersions: { take: 10, where: { id: VERSION }, orderBy: { index: 'asc' } } },
    });
    expect(getKyselyWithoutLag).not.toHaveBeenCalled();
    for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
  });

  it('ON: the same version through Kysely only, in the Prisma shape', async () => {
    givenBothPaths();
    flag.mockResolvedValue(true);
    await expect(lookup(VERSION)).resolves.toStrictEqual(prismaResult.modelVersions[0]);
    expect(getKyselyWithoutLag).toHaveBeenCalledWith('model', MODEL);
    expect(q.listDefaultModelVersionRows.mock.calls).toEqual([
      [kyselyRead, { modelId: MODEL, modelVersionId: VERSION }],
    ]);
    // By identity: `toEqual` compares the two Kysely clients structurally.
    expect(q.listDefaultModelVersionRows.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.model.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.model.findUnique).not.toHaveBeenCalled();
    expect(getDbWithoutLag).not.toHaveBeenCalled();
  });

  it('ON: follows the lag decision to the primary, as the Prisma read does', async () => {
    givenBothPaths();
    flag.mockResolvedValue(true);
    getKyselyWithoutLag.mockResolvedValue(kyselyWrite);
    await lookup();
    expect(q.listDefaultModelVersionRows.mock.calls[0][0]).toBe(kyselyWrite);
  });

  it('ON: a missing model still throws NOT_FOUND, as the Prisma null does', async () => {
    givenBothPaths();
    flag.mockResolvedValue(true);
    q.listDefaultModelVersionRows.mockResolvedValue([]);
    await expect(lookup()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('ON: a model with no matching version resolves undefined, as an empty Prisma list does', async () => {
    givenBothPaths();
    flag.mockResolvedValue(true);
    q.listDefaultModelVersionRows.mockResolvedValue([
      {
        modelId: MODEL,
        modelUserId: OWNER,
        modelAvailability: 'Public',
        modelStatus: 'Published',
        versionId: null,
        versionStatus: null,
        versionPublishedAt: null,
        versionAvailability: null,
        versionTrainingStatus: null,
      },
    ] as never);
    await expect(lookup()).resolves.toBeUndefined();
  });
});
