/**
 * The REAL Node answer for each feed-go `/api/v1/models*` golden fixture
 * (apps/feed-go/testdata/golden/v1-models, written by gen-v1-models.mjs).
 *
 * Each fixture names a request and the synthetic world it reads: the model statement's rows, every
 * cache value, every replica row. This file runs the real route handlers
 * (src/pages/api/v1/models/index.ts and [id].ts) over that world — getModelsRaw, getModelsWithVersions,
 * runModelSearch's and buildPublicModelResponse's shaping, the file naming, the primary-file pick, the
 * edge URLs, the metric privacy, the showcase hold and filter all run as they do in production — with
 * only the I/O answered from the fixture: the model statement (`pgDbRead.cancellableQuery`, whose SQL
 * is captured), the per-id caches' `fetch`, and the small replica reads.
 *
 * It requires the fixture's `expect.body` to be the exact bytes `res.json` writes, and `expect.sql` the
 * model statement this code builds (whitespace-normalised text and its values). feed-go's golden
 * harness (apps/feed-go/internal/v1models/golden_test.go) requires the same bytes and the same
 * statement from Go over the same world, so the two are held to each other through the fixture.
 *
 * On a mismatch the failure message carries `GOLDEN-ACTUAL <file> <json>`: the answer this code gave.
 * A fixture's expectation is only ever set from that output (see the golden README), never from Go's.
 *
 * The cache layer itself is not exercised: each mocked `fetch` returns the fixture's records after
 * the cache's `appendFn` (transcribed in its mock below), which is what a cache hit returns.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as BlockScopeMiddleware from '~/server/middleware/block-scope.middleware';
import type * as FliptClient from '~/server/flipt/client';
import type * as MeiliClient from '~/server/meilisearch/client';
import type * as SystemCache from '~/server/services/system-cache';
import type * as EnvClient from '~/env/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { matureRestrictedBaseModels } from '~/shared/constants/basemodel.constants';

const FIXTURE_DIR = join(process.cwd(), 'apps/feed-go/testdata/golden/v1-models');
const GO_CONSTANTS = join(process.cwd(), 'apps/feed-go/internal/v1models/constants.go');
const IMAGE_LOCATION = 'https://image.example.test/golden';
const BASE_URL = 'https://site.example.test';

type World = Record<string, any>;
type Fixture = {
  name: string;
  now: string;
  config: {
    imageLocation: string;
    baseUrl: string;
    coverageNext: boolean;
    baseModelFeedMetrics: boolean;
    regionRestricted: boolean;
  };
  request: { path: string; query: string; headers: Record<string, string> };
  world: World;
  expect: {
    fallback?: string;
    body?: string | null;
    sql?: { text: string; values: unknown[] } | null;
  };
};

/** JSON-with-markers (gen-v1-models.mjs / pack.mjs) -> the JS value Node holds. */
function revive(v: unknown): any {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$date') return new Date((v as { $date: string }).$date);
    if (keys.length === 1 && keys[0] === '$undefined') return undefined;
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = revive((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

const state = vi.hoisted(() => ({
  fx: undefined as any,
  world: {} as Record<string, any>,
  sql: [] as { text: string; values: unknown[] }[],
}));

/** The fixture's cache records for ids, without notFound markers (what a fetch returns). */
function records(table: Record<string, unknown> | undefined, ids: number[]) {
  const out: Record<number, any> = {};
  for (const id of ids) {
    const v = table?.[id];
    if (v && v !== 'notFound') out[id] = revive(v);
  }
  return out;
}

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: vi.fn(async (sql: { text: string; values: unknown[] }) => {
      state.sql.push({ text: sql.text, values: sql.values });
      return {
        result: async () => revive(state.world.models ?? []),
        cancel: async () => undefined,
      };
    }),
  },
  pgDbWrite: {},
  pgDbReadLong: {},
}));

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // dataForModelsCache with its appendFn: a record's tags come from modelTagCache (whose appendFn
  // names them from tagCache, dropping a tag it does not hold); a model with no model-tags record
  // keeps its own.
  dataForModelsCache: {
    fetch: vi.fn(async (ids: number[]) => {
      const out = records(state.world.modelData, ids);
      for (const id of Object.keys(out)) {
        const mt = state.world.modelTags?.[id];
        if (!mt || mt === 'notFound') continue;
        out[Number(id)].tags = (mt.tagIds as number[])
          .map((tagId) => state.world.tags?.[tagId])
          .filter((t) => t && t !== 'notFound')
          .map((t: { id: number; name: string }) => ({ tagId: t.id, name: t.name }));
      }
      return out;
    }),
  },
  modelVersionPublicDonationGoalsCache: { fetch: vi.fn(), bust: vi.fn() },
  modelTagCache: { fetch: vi.fn(), bust: vi.fn() },
  modelVotableTagsCache: { fetch: vi.fn(), bust: vi.fn() },
  userBasicCache: {
    fetch: vi.fn(async (ids: number[]) => records(state.world.users, ids)),
    bust: vi.fn(),
  },
  userModelCountCache: { fetch: vi.fn(), bust: vi.fn() },
}));

vi.mock('~/server/services/model-file.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFilesForModelVersionCache: vi.fn(async (ids: number[]) => records(state.world.files, ids)),
  deleteFilesForModelVersionCache: vi.fn(),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getImagesForModelVersion: vi.fn(),
  // imagesForModelVersionsCache with its appendFn: each image's `tags` from tagIdsForImagesCache.
  getImagesForModelVersionCache: vi.fn(async (ids: number[]) => {
    const out = records(state.world.images, ids);
    for (const entry of Object.values(out)) {
      for (const image of entry.images) {
        const t = state.world.imageTags?.[image.id];
        image.tags = t && t !== 'notFound' ? t.tags : [];
      }
    }
    return out;
  }),
  queueImageSearchIndexUpdate: vi.fn(),
}));

vi.mock('~/server/services/hot-reads-11.reads', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readModelsWithVersionsStats: vi.fn(async () => {
    const s = revive(state.world.stats);
    return {
      vaeLinkedRows: s.vaeLinked,
      metrics: s.modelMetrics,
      versionMetrics: s.versionMetrics,
      versionMetaRows: s.versionMeta,
    };
  }),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFlipt: vi.fn(async (flag: string) => {
      if (flag === actual.FLIPT_FEATURE_FLAGS.GENERATION_COVERAGE_NEXT)
        return state.fx.config.coverageNext;
      if (flag === 'base-model-feed-metrics') return state.fx.config.baseModelFeedMetrics;
      return false;
    }),
  };
});

vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getBlockedBrowsingTags: vi.fn(async () => []),
  getBrowsingSettingAddons: vi.fn(async () => revive(state.world.addons)),
}));

vi.mock('~/server/services/paid-access.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPaidAccess: vi.fn(),
  // getPaidAccess over the fixture's cached rows, then toPublicPaidAccessDto.
  getPublicPaidAccessForModelVersions: vi.fn(async (ids: number[]) => {
    const out: Record<number, { permanent: boolean; endsAt: Date | null }> = {};
    for (const [id, c] of Object.entries(records(state.world.paidAccess, ids))) {
      const endsAt = c.endsAtMs != null ? new Date(c.endsAtMs) : null;
      if (endsAt != null && !(endsAt > new Date())) continue;
      out[Number(id)] = { permanent: c.timeframeDays == null, endsAt };
    }
    return out;
  }),
  getModelPaidAccessGates: vi.fn(
    async (ids: number[]) =>
      new Map(
        (state.world.paidAccessGates as number[])
          .filter((id) => ids.includes(id))
          .map((id) => [id, { earlyAccessDeadline: null, gated: true }])
      )
  ),
  bustPaidAccessCache: vi.fn(),
  bustModelSaleCache: vi.fn(),
}));

vi.mock('~/server/services/creator-program.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getValidCreatorMembershipMap: vi.fn(
    async (ids: number[]) =>
      new Map(
        ids
          .filter((id) => state.world.membership?.[id] !== undefined)
          .map((id) => [id, state.world.membership[id]])
      )
  ),
  getUserMetricPrivacyDefaultsMap: vi.fn(
    async (ids: number[]) =>
      new Map(
        ids
          .filter((id) => state.world.metricPrivacy?.[id])
          .map((id) => [id, state.world.metricPrivacy[id]])
      )
  ),
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteBasicDataForUser: vi.fn(),
  getCosmeticsForUsers: vi.fn(async () => ({})),
  getProfilePicturesForUsers: vi.fn(async (ids: number[]) =>
    records(state.world.profilePictures, ids)
  ),
  getUserBookmarkCollections: vi.fn(async () => []),
}));
vi.mock('~/server/services/cosmetic.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCosmeticsForEntity: vi.fn(),
}));

vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  publicModelResponseKey: (id: number, browsingLevel: number) =>
    `packed:caches:public-model-response:v2:${id}:${browsingLevel}`,
}));
// The origin cache's write is not under test: a miss builds and returns the body.
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchThroughCache: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('~/server/utils/region-blocking', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRegion: (req: NextApiRequest) => ({
    countryCode: req.headers['cf-ipcountry'],
    regionCode: null,
    fullLocationCode: req.headers['cf-ipcountry'],
  }),
  isRegionRestricted: () => !!state.fx?.config.regionRestricted,
}));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PublicEndpoint: (handler: any) => (req: any, res: any) => handler(req, res),
  MixedAuthEndpoint: (handler: any) => (req: any, res: any) => handler(req, res, undefined),
  handleEndpointError: (res: any, e: any) => res.status(500).json({ error: String(e) }),
}));
vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockScopeMiddleware>()),
  withBlockScope: (handler: any) => (req: any, res: any) => handler(req, res),
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (handler: any) => handler }));
vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  searchClient: undefined,
  withMeili: (_op: string, fn: () => unknown) => fn(),
}));
vi.mock('~/env/client', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvClient>();
  return { ...actual, env: { ...actual.env, NEXT_PUBLIC_IMAGE_LOCATION: IMAGE_LOCATION } };
});

function loadFixtures(): { file: string; fx: Fixture }[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, fx: JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) }));
}

/** Next's `req.query` for a query string: a repeated key collects an array, first-seen order. */
function nextQuery(raw: string) {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

function fakeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, unknown>,
    setHeader(k: string, v: unknown) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

/** A bound value as the fixture writes it: a Date as its ISO string, undefined as null. */
function jsonValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonValue);
  return v;
}

const normalizeSql = (s: string) => s.split(/\s+/).filter(Boolean).join(' ');

let listHandler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
let detailHandler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

beforeAll(async () => {
  // Read at module scope by [id].ts (the origin cache's TTL, getBaseUrl()): set before its import.
  setEnv({ IS_DATAPACKET: true, NEXTAUTH_URL: BASE_URL });
  listHandler = (await import('~/pages/api/v1/models/index')).default as any;
  detailHandler = (await import('~/pages/api/v1/models/[id]')).default as any;
}, 180_000);

const fixtures = loadFixtures();

describe('feed-go /api/v1/models golden fixtures: the real Node answer', () => {
  it('finds the fixtures (a glob that matched nothing would pass every case below)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(14);
    expect(fixtures.filter(({ fx }) => !fx.expect.fallback).length).toBeGreaterThanOrEqual(11);
  });

  it.each(fixtures.filter(({ fx }) => !fx.expect.fallback).map(({ file, fx }) => [file, fx]))(
    '%s',
    async (file, fx) => {
      const f = fx as Fixture;
      expect(f.config.imageLocation).toBe(IMAGE_LOCATION);
      expect(f.config.baseUrl).toBe(BASE_URL);
      state.fx = f;
      state.world = f.world;
      state.sql = [];
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(f.now));
      try {
        dbMock.dbRead.modelFile.findMany.mockImplementation(async () => revive(f.world.vaeFiles));
        dbMock.dbRead.user.findUnique.mockImplementation(async (args: any) => {
          const id = f.world.usernames?.[args?.where?.username];
          return id ? { id } : null;
        });
        redisMock.redis.mGet.mockImplementation(async (keys: string[]) =>
          keys.map((k) => f.world.gallerySettings?.[k.slice(k.lastIndexOf(':') + 1)] ?? null)
        );
        redisMock.redis.packed.get.mockImplementation(
          async (key: string) => revive(f.world.responseCache?.[key]) ?? null
        );

        const { path, query, headers } = f.request;
        const req: any = {
          method: 'GET',
          url: query ? `${path}?${query}` : path,
          headers,
          query: nextQuery(query),
        };
        const id = path.startsWith('/api/v1/models/') ? path.slice('/api/v1/models/'.length) : '';
        if (id) req.query = { ...req.query, id };
        const res = fakeRes();
        await (id ? detailHandler : listHandler)(req, res);

        const body = JSON.stringify(res.body);
        const sql = state.sql[0]
          ? { text: normalizeSql(state.sql[0].text), values: jsonValue(state.sql[0].values) }
          : null;
        const actual = { status: res.statusCode, body, sql };
        expect(state.sql.length, `${file}: one model statement at most`).toBeLessThanOrEqual(1);
        expect(actual, `GOLDEN-ACTUAL ${file} ${JSON.stringify({ body, sql })}`).toEqual({
          status: 200,
          body: f.expect.body,
          sql: f.expect.sql ? { ...f.expect.sql, text: normalizeSql(f.expect.sql.text) } : null,
        });
      } finally {
        vi.useRealTimers();
      }
    },
    120_000
  );
});

describe('feed-go v1models constants', () => {
  it("lists exactly matureRestrictedBaseModels('models'), lowercased", () => {
    const src = readFileSync(GO_CONSTANTS, 'utf8');
    const block = src.slice(
      src.indexOf('var matureRestrictedModels'),
      src.indexOf('\n}\n', src.indexOf('var matureRestrictedModels'))
    );
    const goNames = [...block.matchAll(/"([^"]+)":\s*true/g)].map((m) => m[1]).sort();
    expect(goNames.length).toBeGreaterThan(0);
    expect(goNames).toEqual(
      matureRestrictedBaseModels('models')
        .map((n) => n.toLowerCase())
        .sort()
    );
  });
});
