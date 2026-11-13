import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `modelVersion.getById` used to load these two relations as nested Prisma selects:
 *
 *   recommendedResources: { select: { id: true, resource: { select: { id: true } }, settings: true } }
 *   generationCoverage: { select: { covered: true, coveredNext: true } }
 *
 * The raw statement that replaced them runs here on a real Postgres (PGlite), and the expected
 * values are the literal shapes those selects return: `null` for no coverage row, `[]` for no
 * resources, keys in select order, `settings` as stored JSON (or `null`).
 */

const { stale } = vi.hoisted(() => ({ stale: { value: false } }));
vi.mock('~/server/db/db-lag-helpers', async () => {
  const { dbMock: mock } = await import('~/__tests__/mocks/db.mock');
  return {
    getDbWithoutLag: vi.fn(async () => (stale.value ? mock.dbWrite : mock.dbRead)),
  };
});

const { getDbWithoutLag } = await import('~/server/db/db-lag-helpers');
const { getVersionByIdWithGenerationChildren } = await import(
  '../model-version-generation-children.service'
);

let pg: PGlite;
const runOn = async (query: Prisma.Sql) => (await pg.query(query.text, query.values)).rows;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "GenerationCoverage" (
      "modelId" INT NOT NULL,
      "modelVersionId" INT NOT NULL UNIQUE,
      "covered" BOOLEAN NOT NULL,
      "coveredNext" BOOLEAN NOT NULL,
      PRIMARY KEY ("modelId", "modelVersionId")
    );
    CREATE TABLE "RecommendedResource" (
      "id" SERIAL PRIMARY KEY,
      "resourceId" INT NOT NULL,
      "sourceId" INT,
      "settings" JSONB
    );
    INSERT INTO "GenerationCoverage" VALUES (1, 100, true, false), (1, 101, false, true);
    INSERT INTO "RecommendedResource" ("id", "resourceId", "sourceId", "settings") VALUES
      (1, 500, 100, '{"strength": 0.8}'),
      (2, 501, 100, NULL),
      (3, 502, 100, '{"isLinkedComponent": true, "fileId": 9, "componentType": "VAE"}'),
      (4, 503, 999, '{"strength": 1}'),
      (5, 504, NULL, NULL);
  `);
});
afterAll(() => pg.close());

beforeEach(() => {
  vi.clearAllMocks();
  stale.value = false;
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.modelVersion.findUnique.mockReset();
    client.modelVersion.findUnique.mockImplementation((async ({
      where,
    }: {
      where: { id: number };
    }) => ({ id: where.id, name: `v${where.id}` })) as never);
    client.$queryRaw.mockReset();
    client.$queryRaw.mockImplementation(runOn as never);
  }
});

const load = (id: number, forceWriteDb?: boolean) =>
  getVersionByIdWithGenerationChildren({ id, select: { id: true, name: true }, forceWriteDb });

describe('getVersionByIdWithGenerationChildren', () => {
  it('returns the coverage row and every resource recommended by THIS version', async () => {
    const version = await load(100);

    expect(version).toStrictEqual({
      id: 100,
      name: 'v100',
      generationCoverage: { covered: true, coveredNext: false },
      recommendedResources: expect.arrayContaining([
        { id: 1, resource: { id: 500 }, settings: { strength: 0.8 } },
        { id: 2, resource: { id: 501 }, settings: null },
        {
          id: 3,
          resource: { id: 502 },
          settings: { isLinkedComponent: true, fileId: 9, componentType: 'VAE' },
        },
      ]),
    });
    expect(version?.recommendedResources).toHaveLength(3);
    // Same key order as the nested select's objects.
    expect(JSON.stringify(version?.generationCoverage)).toBe(
      '{"covered":true,"coveredNext":false}'
    );
    expect(JSON.stringify(version?.recommendedResources.find((r) => r.id === 2))).toBe(
      '{"id":2,"resource":{"id":501},"settings":null}'
    );
  });

  it('reads the coverage columns, not row existence', async () => {
    expect((await load(101))?.generationCoverage).toStrictEqual({
      covered: false,
      coveredNext: true,
    });
  });

  it('returns null coverage and an empty list when the version has neither', async () => {
    const version = await load(102);
    expect(version?.generationCoverage).toBeNull();
    expect(version?.recommendedResources).toStrictEqual([]);
  });

  it('returns null for a missing version', async () => {
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(null as never);
    expect(await load(100)).toBeNull();
  });

  it('reads the version and its children with ONE extra statement on the same client', async () => {
    await load(100);
    // The lag guard is keyed on the version, the same key getVersionById uses.
    expect(getDbWithoutLag).toHaveBeenCalledTimes(1);
    expect(getDbWithoutLag).toHaveBeenCalledWith('modelVersion', 100);
    expect(dbMock.dbRead.modelVersion.findUnique).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.modelVersion.findUnique.mock.calls[0][0]).toEqual({
      where: { id: 100 },
      select: { id: true, name: true },
    });
    expect(dbMock.dbRead.$queryRaw).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.modelVersion.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    ['forceWriteDb', true, false],
    ['a recent write (lag guard)', false, true],
  ])('reads both from the primary on %s', async (_label, forceWriteDb, isStale) => {
    stale.value = isStale;
    await load(100, forceWriteDb);
    if (forceWriteDb) expect(getDbWithoutLag).not.toHaveBeenCalled();
    else expect(getDbWithoutLag).toHaveBeenCalledWith('modelVersion', 100);
    expect(dbMock.dbWrite.modelVersion.findUnique).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.modelVersion.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});
