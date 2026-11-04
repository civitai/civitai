import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads3 from '@civitai/db-queries/hot-reads-3';
import type * as LagHelpers from '~/server/db/db-lag-helpers';

// Mocked for the invariant guard that no flag check remains on this read (not regression
// coverage).
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read-3 statement stubbed: their rows, against a real database, are pinned in
// hot-reads-3.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-3', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads3>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// The lag decision, so a test can make it pick the primary and see the read follow it.
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
 * The model page's default-version lookup (`getDefaultModelVersion`): which client it reads, and
 * that the Kysely rows reach the caller's logic in the shape the Prisma read returned. Their rows,
 * against a real database, are pinned in hot-reads-3.kysely-parity.test.ts.
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

/** The lookup in the Prisma `model.findUnique` shape. */
const expected = {
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

function givenRows() {
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

  it('reads through Kysely only, in the Prisma shape (invariant: no flag check remains)', async () => {
    givenRows();
    await expect(lookup(VERSION)).resolves.toStrictEqual(expected.modelVersions[0]);
    expect(getKyselyWithoutLag).toHaveBeenCalledWith('model', MODEL);
    expect(q.listDefaultModelVersionRows.mock.calls).toEqual([
      [kyselyRead, { modelId: MODEL, modelVersionId: VERSION }],
    ]);
    // By identity: `toEqual` compares the two Kysely clients structurally.
    expect(q.listDefaultModelVersionRows.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.model.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.model.findUnique).not.toHaveBeenCalled();
    expect(getDbWithoutLag).not.toHaveBeenCalled();
    expect(flag, 'invariant: no flag check remains').not.toHaveBeenCalled();
  });

  it('follows the lag decision to the primary, as the Prisma read did', async () => {
    givenRows();
    getKyselyWithoutLag.mockResolvedValue(kyselyWrite);
    await lookup();
    expect(q.listDefaultModelVersionRows.mock.calls[0][0]).toBe(kyselyWrite);
  });

  it('a missing model still throws NOT_FOUND, as the Prisma null did', async () => {
    q.listDefaultModelVersionRows.mockResolvedValue([]);
    await expect(lookup()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a model with no matching version resolves undefined, as an empty Prisma list did', async () => {
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
