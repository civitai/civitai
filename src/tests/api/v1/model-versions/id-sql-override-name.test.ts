import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import type * as ModelVisibility from '~/server/services/model-visibility.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

void loggingMock;
void redisMock;

/**
 * GET /api/v1/model-versions/{id} builds each file in its own raw SQL, so a column that query
 * leaves out never reaches the response however the shaper treats it. Here the route's real query
 * runs on PGlite: a creator-set `overrideName` must survive the SQL and name the file.
 */

let db: PGlite;
const mockHold = vi.hoisted(() => vi.fn(async (byVersion: unknown) => byVersion));

vi.mock('~/server/services/model-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVisibility>()),
  getHiddenModelVersionIds: async () => new Set<number>(),
}));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  getModelVersionPrivacyRow: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/training-data-restricted.service', () => ({
  trainingDataListing: async () => () => true,
}));
vi.mock('~/server/services/model.service', () => ({
  getVaeFiles: async () => [],
  holdShowcaseImages: mockHold,
}));
vi.mock('~/server/services/image.service', () => ({ getImagesForModelVersion: async () => [] }));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: async () => ({}),
  toPublicPaidAccessDto: () => null,
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  hasValidCreatorMembershipCached: async () => false,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint: (handler: any) => handler,
  PublicEndpoint: (handler: any) => handler,
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => 'US',
  isRegionRestricted: () => false,
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));

const VERSION_ID = 4242;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Published');
    CREATE TABLE "Model" (
      id int PRIMARY KEY, name text, "sfwName" text, type text, nsfw boolean, poi boolean,
      mode text, availability text, "userId" int, minor boolean, "sfwOnly" boolean
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int, name text, "nsfwLevel" int, "createdAt" timestamp(3),
      "updatedAt" timestamp(3), status "ModelStatus", "publishedAt" timestamp(3),
      "trainedWords" text[], "trainingStatus" text, "trainingDetails" jsonb, "baseModel" text,
      "baseModelType" text, description text, "uploadType" text, "usageControl" text,
      availability text
    );
    CREATE TABLE "RecommendedResource" ("resourceId" int, "sourceId" int, settings jsonb);
    CREATE TABLE "ModelVersionMetric" (
      "modelVersionId" int, timeframe text, "downloadCount" int, "ratingCount" int,
      rating float, "thumbsUpCount" int, "thumbsDownCount" int
    );
    CREATE TABLE "ModelFile" (
      id int PRIMARY KEY, url text, "sizeKB" float, name text, "overrideName" text, type text,
      visibility text, metadata jsonb, "pickleScanResult" text, "pickleScanMessage" text,
      "virusScanResult" text, "virusScanMessage" text, "scannedAt" timestamp(3),
      "modelVersionId" int
    );
    CREATE TABLE "ModelFileHash" ("fileId" int, type text, hash text);

    INSERT INTO "Model" VALUES (7, 'Qwen Image', NULL, 'Checkpoint', false, false, NULL, 'Public', 1, false, false);
    INSERT INTO "ModelVersion" VALUES (${VERSION_ID}, 7, 'v1', 1, now(), now(), 'Published', now(),
      '{}', NULL, NULL, 'SD 1.5', NULL, NULL, 'Created', 'Download', 'Public');
    INSERT INTO "ModelFile" VALUES
      (11, 's3://a', 1111, 'stored_a.safetensors', NULL, 'Model', 'Public',
       '{"format":"SafeTensor","size":"full","fp":"bf16"}', 'Success', NULL, 'Success', NULL, now(), ${VERSION_ID}),
      (12, 's3://b', 2222, 'stored_b.safetensors', 'creator-picked.safetensors', 'Model', 'Public',
       '{"format":"SafeTensor","size":"pruned","fp":"fp16"}', 'Success', NULL, 'Success', NULL, now(), ${VERSION_ID});
  `);
});
// The route's own query, run for real on PGlite.
beforeEach(() => {
  dbMock.dbRead.$queryRaw.mockImplementation(((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const query = Prisma.sql(strings, ...values);
    return db.query(query.text, query.values as unknown[]).then((r) => r.rows);
  }) as never);
});
afterAll(async () => {
  await db.close();
});

async function getVersion() {
  const mod = await import('~/pages/api/v1/model-versions/[id]');
  const handler = mod.default as unknown as (
    req: NextApiRequest,
    res: NextApiResponse,
    user: undefined
  ) => Promise<void>;
  const res: any = {
    headers: {} as Record<string, unknown>,
    setHeader(k: string, v: unknown) {
      this.headers[k] = v;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  const req = {
    method: 'GET',
    query: { id: String(VERSION_ID) },
    headers: { host: 'civitai.com' },
  } as unknown as NextApiRequest;
  await handler(req, res, undefined);
  return res as { statusCode: number; body: any };
}

describe('GET /api/v1/model-versions/{id} — the raw SQL carries overrideName', () => {
  it('names a creator-renamed file by its override, and returns the override', async () => {
    const { statusCode, body } = await getVersion();
    expect(statusCode).toBe(200);

    const byId = Object.fromEntries((body.files as any[]).map((f) => [f.id, f]));
    expect(byId[12].overrideName).toBe('creator-picked.safetensors');
    expect(byId[12].name).toBe('creator-picked.safetensors');
    expect(byId[11].overrideName).toBeNull();
    expect(byId[11].name).not.toBe('creator-picked.safetensors');
  });
});

describe('GET /api/v1/model-versions/{id} — the raw SQL carries the model flags to the showcase hold', () => {
  afterAll(async () => {
    await db.exec(`UPDATE "Model" SET minor = false, "sfwOnly" = false WHERE id = 7`);
  });

  it.each([
    { minor: true, sfwOnly: false },
    { minor: false, sfwOnly: true },
    { minor: false, sfwOnly: false },
  ])('passes minor=$minor, sfwOnly=$sfwOnly from the row, and serves neither', async (flags) => {
    await db.exec(
      `UPDATE "Model" SET minor = ${flags.minor}, "sfwOnly" = ${flags.sfwOnly} WHERE id = 7`
    );
    mockHold.mockClear();
    const { statusCode, body } = await getVersion();
    expect(statusCode).toBe(200);
    expect(mockHold).toHaveBeenCalledTimes(1);
    const models = mockHold.mock.calls[0][1] as Map<number, unknown>;
    expect(models.get(VERSION_ID)).toEqual({ modelId: 7, ...flags });
    expect(body.model).not.toHaveProperty('minor');
    expect(body.model).not.toHaveProperty('sfwOnly');
  });
});
