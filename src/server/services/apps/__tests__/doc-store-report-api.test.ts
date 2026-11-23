// Setup-order import: installs the env mock with the test RSA keypair BEFORE the block-token
// service and the middleware read it at module load.
import '~/__tests__/setup';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import '~/__tests__/mocks/logging.mock';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as FliptClient from '~/server/flipt/client';
import type * as SessionClientModule from '~/server/auth/session-client';
import type * as Moderation from '~/server/services/apps/shared-data-moderation';
import type { SharedTextScan } from '~/server/services/apps/shared-data-moderation';
import type { DocStore } from '~/server/services/apps/doc-store';
import { createLuaRedis, type LuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { createPgliteHarness, type Harness } from './doc-store.harness';

/**
 * THE REPORT MODERATION API (`POST /api/v1/blocks/moderation/reports`), end to end: a REAL signed
 * block token → the REAL `withBlockScope` → the REAL page → the REAL resolver → the REAL document
 * store on an embedded Postgres with RLS, and the REAL moderator facet reading what it wrote.
 * Replaced at the boundary only, as in `doc-store-api.tally-operators.test.ts`: the Postgres rows
 * the resolver reads, Redis (an in-memory map), the session hub, the App Blocks and Flipt flags and
 * the moderation scanner. The old path (`PATCH {"$mark":"report"}` on the storage route) is driven
 * beside it wherever the two must agree, since both stay live during the compat window.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  store: undefined as unknown as DocStore,
  users: new Map<number, unknown>(),
  /** `app-blocks-storage-report-api`, for every app; and every entity it was evaluated for. */
  reportFlag: true,
  reportFlagEntities: [] as (string | undefined)[],
}));

const REPORT_FLAG = 'app-blocks-storage-report-api';
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const real = await importOriginal<typeof FliptClient>();
  return {
    ...real,
    isFlipt: async (flag: string, entityId?: string, context?: unknown) => {
      if (flag === REPORT_FLAG) {
        h.reportFlagEntities.push(entityId);
        return h.reportFlag;
      }
      if (flag === 'app-blocks-shared-data-moderation') return false;
      if (flag === 'app-blocks-shared-data-moderation-enforce') return true;
      return real.isFlipt(flag, entityId, context as never);
    },
  };
});
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksRuntimeEnabled: vi.fn(async () => true),
  isAppBlocksEnabled: vi.fn(async () => true),
  isAppBlocksAuthorEnabled: vi.fn(async () => true),
}));
vi.mock('~/server/auth/session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionClientModule>()),
  sessionClient: { getSessionUserById: vi.fn(async (id: number) => h.users.get(id) ?? null) },
}));
vi.mock('~/server/services/apps/doc-store.instance', () => ({ getDocStore: () => h.store }));
vi.mock('~/server/services/apps/shared-data-moderation', async (importOriginal) => {
  const real = await importOriginal<typeof Moderation>();
  const clean = (): SharedTextScan => ({ leafCount: 1, overflow: null, hits: [] });
  return {
    ...real,
    scanSharedData: vi.fn(async () => clean()),
    scanCounterKey: vi.fn(async () => clean()),
    recordSharedDataScan: vi.fn(async () => undefined),
  };
});

import { BlockTokenService } from '~/server/services/block-token.service';
import { OnboardingSteps } from '~/server/common/enums';
import { REDIS_KEYS } from '~/server/redis/client';
import {
  createDocStore,
  createDocStoreModeration,
  PUBLISHED_NS,
} from '~/server/services/apps/doc-store';
import { recordStorageImportGrants } from '~/server/services/apps/storage-import-grant.service';
import { DOC_STORE_REPORT_RATE_LIMIT_MAX } from '~/server/utils/shared-storage-rate-limit';
import storageRoute from '~/pages/api/v1/blocks/storage/[[...path]]';
import reportRoute from '~/pages/api/v1/blocks/moderation/reports';

const SCOPES = ['apps:storage', 'apps:storage:publish'];
// Distinctive ids, none of which appears in any fixture value or constant below.
const UID = { v1: 847_013, v2: 847_029, v3: 847_031, v4: 847_043, newbie: 847_057 } as const;
type Viewer = keyof typeof UID;

const MANIFEST = {
  scopes: SCOPES,
  storage: {
    collections: {
      prefs: { visibility: 'private' },
      posts: { visibility: 'shared', write: 'own', marks: ['vote'], counters: ['views'] },
    },
  },
};

type AppRow = { id: string; appId: string; blockId: string; status: string; manifest: unknown };
let apps: AppRow[] = [];
let seq = 0;

function freshApp(manifest: unknown = MANIFEST, label = 'rpt'): AppRow {
  seq += 1;
  const row = {
    id: `apb_${label}${seq}`,
    appId: `appblk-${label}${seq}`,
    blockId: `${label}-${seq}`,
    status: 'approved',
    manifest,
  };
  apps.push(row);
  return row;
}

function user(name: Viewer) {
  const trusted = name !== 'newbie';
  return {
    id: UID[name],
    username: `report_${name}`,
    createdAt: trusted ? new Date('2020-01-01T00:00:00Z') : new Date(),
    emailVerified: new Date('2020-01-02T00:00:00Z'),
    onboarding: OnboardingSteps.Buzz,
    bannedAt: null,
    muted: false,
    isModerator: false,
    tier: 'free',
  };
}

const kv = new Map<string, { value: string; ttl: number }>();
let lua: LuaRedis;

function installRedis() {
  kv.clear();
  lua = createLuaRedis(Date.parse('2031-03-04T05:06:07.000Z'));
  const get = async (key: string) => kv.get(key)?.value ?? null;
  redisMock.redis.get.mockImplementation(get);
  redisMock.redis.mGet.mockImplementation(async (keys: string[]) => Promise.all(keys.map(get)));
  redisMock.redis.set.mockImplementation(async (key: string, value: unknown) => {
    kv.set(key, { value: String(value), ttl: -1 });
    return 'OK';
  });
  redisMock.redis.del.mockImplementation(async (key: string) => (kv.delete(key) ? 1 : 0));
  redisMock.redis.incrBy.mockImplementation(async (key: string, by: number) => {
    const cur = kv.get(key);
    const value = Number(cur?.value ?? 0) + by;
    kv.set(key, { value: String(value), ttl: cur?.ttl ?? -1 });
    return value;
  });
  redisMock.redis.expire.mockImplementation(async (key: string, seconds: number) => {
    const cur = kv.get(key);
    if (cur) cur.ttl = seconds;
    return true;
  });
  redisMock.redis.ttl.mockImplementation(async (key: string) => kv.get(key)?.ttl ?? -2);
  redisMock.redis.eval.mockImplementation(
    (script: string, options: { keys: string[]; arguments: string[] }) => lua.eval(script, options)
  );
}

function installDb() {
  dbMock.dbRead.appBlock.findUnique.mockImplementation(
    async ({
      where,
    }: {
      where: { id?: string; blockId?: string; appId_blockId?: { appId: string; blockId: string } };
    }) => {
      const pair = where.appId_blockId;
      return (
        apps.find((a) =>
          pair
            ? a.appId === pair.appId && a.blockId === pair.blockId
            : where.blockId !== undefined
            ? a.blockId === where.blockId
            : a.id === where.id
        ) ?? null
      );
    }
  );
  dbMock.dbRead.appBlock.findMany.mockImplementation(
    async ({ where }: { where: { blockId?: { in: string[] }; status?: string } }) =>
      apps.filter(
        (a) =>
          (where.blockId?.in ?? []).includes(a.blockId) &&
          (where.status === undefined || a.status === where.status)
      )
  );
  dbMock.dbRead.user.findMany.mockImplementation(
    async ({ where }: { where: { id: { in: number[] } } }) =>
      [...h.users.values()]
        .map((u) => u as { id: number; username: string })
        .filter((u) => where.id.in.includes(u.id))
        .map((u) => ({ id: u.id, username: u.username }))
  );
  dbMock.dbRead.account.count.mockResolvedValue(0);
}

async function mint(app: AppRow, uid: number | null, scopes: string[] = SCOPES): Promise<string> {
  const { token } = await BlockTokenService.sign({
    userId: uid,
    blockId: app.blockId,
    appId: app.appId,
    appBlockId: app.id,
    blockInstanceId: `bki_${app.id}`,
    scopes,
    ctx: {},
    maxBrowsingLevel: 1,
    domain: 'green',
  });
  return token;
}

type Reply = { status: number; body: Record<string, unknown>; headers: Record<string, unknown> };

function fakeRes() {
  const headers: Record<string, unknown> = {};
  const out = { status: 0, body: undefined as unknown, headers };
  const res = {
    statusCode: 0,
    status(code: number) {
      out.status = code;
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      out.body = payload;
      return res;
    },
    end: () => res,
    send: () => res,
    setHeader(k: string, v: unknown) {
      headers[k.toLowerCase()] = v;
      return res;
    },
    getHeader: (k: string) => headers[k.toLowerCase()],
    removeHeader: () => res,
    writeHead: () => res,
    on: () => res,
  };
  return { res: res as unknown as NextApiResponse, out };
}

const asReply = (out: { status: number; body: unknown; headers: Record<string, unknown> }) =>
  ({ ...out, body: (out.body ?? {}) as Record<string, unknown> } as Reply);

/** The report API. The page's body parser is on, so the body arrives parsed, as Next hands it. */
async function report(
  token: string | null,
  body: unknown,
  opts: { method?: string; query?: Record<string, string> } = {}
): Promise<Reply> {
  const req = {
    method: opts.method ?? 'POST',
    url: '/api/v1/blocks/moderation/reports',
    query: { ...(opts.query ?? {}) },
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
    socket: { remoteAddress: '198.51.100.23' },
  } as unknown as NextApiRequest;
  const { res, out } = fakeRes();
  await reportRoute(req, res);
  return asReply(out);
}

/** The storage route (its body parser is off: the body is streamed). */
async function storage(opts: {
  token: string | null;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}): Promise<Reply> {
  const segments = opts.path.split('/').filter(Boolean);
  const text = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const req = Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {
    method: opts.method,
    url: `/api/v1/blocks/storage${opts.path}`,
    query: { ...(opts.query ?? {}), ...(segments.length ? { path: segments } : {}) },
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    socket: { remoteAddress: '198.51.100.23' },
  }) as unknown as NextApiRequest;
  const { res, out } = fakeRes();
  await storageRoute(req, res);
  return asReply(out);
}

const reportAs = async (app: AppRow, who: Viewer | 'anon', key: string, coll = 'posts') =>
  report(await mint(app, who === 'anon' ? null : UID[who]), { collection: coll, key });

/** The OLD path, unchanged: the `report` mark as a PATCH update operator. */
const markReportAs = async (app: AppRow, who: Viewer, key: string) =>
  storage({
    token: await mint(app, UID[who]),
    method: 'PATCH',
    path: `/posts/${key}`,
    body: { $mark: 'report' },
  });

async function putPost(app: AppRow, key: string, author: Viewer = 'v1') {
  const r = await storage({
    token: await mint(app, UID[author]),
    method: 'PUT',
    path: `/posts/${key}`,
    body: { data: { status: 'open' } },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** The report rows and the `report` tally of one document. */
async function reportRows(app: AppRow, key: string, coll = 'posts') {
  const rows = await harness.raw(
    `SELECT user_id FROM appdata.doc_mark
      WHERE app_id = $1 AND ns = 'prod' AND coll = $2 AND key = $3 AND name = 'report'
      ORDER BY user_id`,
    [app.id, coll, key]
  );
  const tally = await harness.raw(
    `SELECT count::int AS count FROM appdata.doc_tally
      WHERE app_id = $1 AND ns = 'prod' AND coll = $2 AND key = $3 AND kind = 'mark' AND name = 'report'`,
    [app.id, coll, key]
  );
  return {
    reporters: rows.map((r) => Number(r.user_id)),
    tally: tally.length === 0 ? null : Number(tally[0].count),
  };
}

const mod = () => createDocStoreModeration({ db: harness.db });
const openQueue = async (app: AppRow) =>
  (await mod().listReported(app.id, PUBLISHED_NS, { status: 'open', limit: 50 })).map(
    (q) => `${q.collection}/${q.key}:${q.reports}`
  );

const reportBucketKey = (app: AppRow, who: Viewer) =>
  `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:docs-report:${app.id}:u:${UID[who]}`;

// PGlite's clock ticks in milliseconds; step past a tick around a dismissal.
const tick = () => new Promise((r) => setTimeout(r, 5));

let harness: Harness;

beforeAll(async () => {
  harness = await createPgliteHarness({ rls: true });
  h.store = createDocStore({ db: harness.db });
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(() => {
  apps = [];
  h.reportFlag = true;
  h.reportFlagEntities = [];
  h.users.clear();
  for (const name of Object.keys(UID) as Viewer[]) h.users.set(UID[name], user(name));
  installRedis();
  installDb();
});

afterEach(() => {
  expect(lua.errors).toEqual([]);
});

describe('POST /moderation/reports', () => {
  it("lands in the moderators' queue as one report row, with no report tally", async () => {
    const app = freshApp();
    await putPost(app, 'q1');
    const r = await reportAs(app, 'v2', 'q1');
    expect({ status: r.status, body: r.body }).toEqual({ status: 200, body: { reported: true } });
    expect(await openQueue(app)).toEqual(['posts/q1:1']);
    expect(await reportRows(app, 'q1')).toEqual({ reporters: [UID.v2], tally: null });
    // The flag was read for the REQUESTING app.
    expect(h.reportFlagEntities).toEqual([app.id]);
  });

  it('answers exactly {reported: true}, never a count; the same viewer twice is one row', async () => {
    const app = freshApp();
    await putPost(app, 'q2');
    const answers = [];
    for (const who of ['v2', 'v3', 'v4', 'v2'] as Viewer[]) {
      const r = await reportAs(app, who, 'q2');
      answers.push({ status: r.status, body: r.body });
    }
    expect(answers).toEqual(Array(4).fill({ status: 200, body: { reported: true } }));
    // Three distinct reporters really are stored (v2's repeat added no row), so a count was
    // there to leak.
    expect((await reportRows(app, 'q2')).reporters).toEqual([UID.v2, UID.v3, UID.v4]);
    expect(await openQueue(app)).toEqual(['posts/q2:3']);
  });

  it('anonymous is refused 401 sign_in_required, and nothing is written', async () => {
    const app = freshApp();
    await putPost(app, 'q4');
    const r = await reportAs(app, 'anon', 'q4');
    expect({ status: r.status, code: r.body.code }).toEqual({
      status: 401,
      code: 'sign_in_required',
    });
    expect(await reportRows(app, 'q4')).toEqual({ reporters: [], tally: null });
  });

  it('the trust gate refuses a new account (403 not_eligible), after spending its report token', async () => {
    const app = freshApp();
    await putPost(app, 'q5');
    const r = await reportAs(app, 'newbie', 'q5');
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 403, code: 'not_eligible' });
    expect(await reportRows(app, 'q5')).toEqual({ reporters: [], tally: null });
    expect(kv.get(reportBucketKey(app, 'newbie'))?.value).toBe('1');
  });

  it('a missing or hidden document is 404 not_found; a private collection is 400 before any budget', async () => {
    const app = freshApp();
    await putPost(app, 'q6');
    await mod().setHidden(app.id, PUBLISHED_NS, 'posts', 'q6', true, UID.v4);
    expect((await reportAs(app, 'v2', 'q6')).body.code).toBe('not_found');
    expect((await reportAs(app, 'v2', 'nope')).body.code).toBe('not_found');
    const priv = await reportAs(app, 'v3', 'mine', 'prefs');
    expect({ status: priv.status, code: priv.body.code }).toEqual({
      status: 400,
      code: 'invalid_request',
    });
    expect(kv.get(reportBucketKey(app, 'v3'))).toBeUndefined();
    const undeclared = await reportAs(app, 'v3', 'x', 'ghosts');
    expect({ status: undeclared.status, code: undeclared.body.code }).toEqual({
      status: 404,
      code: 'collection_not_declared',
    });
  });

  it('refuses a malformed body, a stray query and any method but POST', async () => {
    const app = freshApp();
    const token = await mint(app, UID.v2);
    const extra = await report(token, { collection: 'posts', key: 'k', reason: 'spam' });
    expect({ status: extra.status, code: extra.body.code }).toEqual({
      status: 400,
      code: 'invalid_request',
    });
    const stray = await report(token, { collection: 'posts', key: 'k' }, { query: { a: '1' } });
    expect({ status: stray.status, code: stray.body.code }).toEqual({
      status: 400,
      code: 'invalid_request',
    });
    for (const method of ['GET', 'DELETE']) {
      const r = await report(token, undefined, { method });
      expect({ status: r.status, code: r.body.code, allow: r.headers.allow }).toEqual({
        status: 405,
        code: 'method_not_allowed',
        allow: 'POST',
      });
    }
  });

  it('flag off: 404 not_found for every method, nothing written, no budget spent', async () => {
    const app = freshApp();
    await putPost(app, 'q7');
    h.reportFlag = false;
    for (const method of ['POST', 'DELETE']) {
      const r = await report(
        await mint(app, UID.v2),
        { collection: 'posts', key: 'q7' },
        { method }
      );
      expect({ status: r.status, code: r.body.code }).toEqual({ status: 404, code: 'not_found' });
    }
    expect(await reportRows(app, 'q7')).toEqual({ reporters: [], tally: null });
    expect(kv.get(reportBucketKey(app, 'v2'))).toBeUndefined();
    // The old path is untouched by the flag.
    expect((await markReportAs(app, 'v2', 'q7')).body).toEqual({ marked: true });
  });
});

describe('the reports-per-day limit', () => {
  // docs/app-storage-generic-core.md ("The report moderation API"): the `report` bucket as today,
  // under the same key, so the mark and the API spend one daily budget.
  it('is 20 per viewer per app, and ONE budget shared with the report mark', async () => {
    // The literal, so a changed constant cannot change what this asserts.
    expect(DOC_STORE_REPORT_RATE_LIMIT_MAX).toBe(20);
    const app = freshApp();
    await putPost(app, 'rl1');
    await putPost(app, 'rl2');
    const statuses = [];
    // Alternate the new API and the old mark: each spends from the same daily bucket, a repeat
    // of a report already filed included.
    for (let i = 0; i < 20; i++) {
      const r =
        i % 2 === 0 ? await reportAs(app, 'v3', 'rl1') : await markReportAs(app, 'v3', 'rl1');
      statuses.push(r.status);
    }
    expect(statuses).toEqual(Array(20).fill(200));
    expect(kv.get(reportBucketKey(app, 'v3'))?.value).toBe('20');
    // The 21st, on another document, through either path.
    const viaApi = await reportAs(app, 'v3', 'rl2');
    const viaMark = await markReportAs(app, 'v3', 'rl2');
    for (const r of [viaApi, viaMark]) {
      expect({
        status: r.status,
        code: r.body.code,
        bucket: (r.body.details as { bucket?: string } | undefined)?.bucket,
      }).toEqual({ status: 429, code: 'rate_limited', bucket: 'report' });
    }
    expect(viaApi.headers['retry-after']).toBeDefined();
    expect(await reportRows(app, 'rl2')).toEqual({ reporters: [], tally: null });
    // Another viewer's bucket is their own.
    expect((await reportAs(app, 'v4', 'rl2')).status).toBe(200);
  });
});

describe('the moderator queue with old-path and new-path reports', () => {
  it('counts every report exactly once: open, total, queue and the audit total', async () => {
    const app = freshApp();
    await putPost(app, 'mx');
    // v1 by the mark (row + tally), v2 by the API (row only), v3 by the API and then the mark (one
    // row; the mark finds it held and moves no tally), v4 by the mark and then the API (one row).
    expect((await markReportAs(app, 'v1', 'mx')).status).toBe(200);
    expect((await reportAs(app, 'v2', 'mx')).status).toBe(200);
    expect((await reportAs(app, 'v3', 'mx')).status).toBe(200);
    expect((await markReportAs(app, 'v3', 'mx')).status).toBe(200);
    expect((await markReportAs(app, 'v4', 'mx')).status).toBe(200);
    expect((await reportAs(app, 'v4', 'mx')).status).toBe(200);
    // The two stores disagree: four rows, a tally of two (v1, v4). Only the rows are right.
    expect(await reportRows(app, 'mx')).toEqual({
      reporters: [UID.v1, UID.v2, UID.v3, UID.v4],
      tally: 2,
    });
    const doc = (await mod().get(app.id, PUBLISHED_NS, 'posts', 'mx'))!;
    expect({ open: doc.reports, total: doc.reportsTotal, marks: doc.marks }).toEqual({
      open: 4,
      total: 4,
      // No tally but the report one was ever written, and the report one is not read.
      marks: {},
    });
    expect(await openQueue(app)).toEqual(['posts/mx:4']);
  });

  it('dismissed, then a newer report re-opens it; an earlier reporter cannot', async () => {
    const app = freshApp();
    await putPost(app, 'dz');
    expect((await reportAs(app, 'v2', 'dz')).status).toBe(200);
    expect((await markReportAs(app, 'v3', 'dz')).status).toBe(200);
    await tick();
    expect(await mod().dismissReports(app.id, PUBLISHED_NS, 'posts', 'dz')).toEqual({
      dismissed: 2,
    });
    await tick();
    expect(await openQueue(app)).toEqual([]);
    // Both earlier reporters again, through either path: no new row, still closed.
    expect((await reportAs(app, 'v2', 'dz')).body).toEqual({ reported: true });
    expect((await reportAs(app, 'v3', 'dz')).body).toEqual({ reported: true });
    expect(await openQueue(app)).toEqual([]);
    // A viewer who had not reported it re-opens it, with one open report.
    expect((await reportAs(app, 'v4', 'dz')).status).toBe(200);
    expect(await openQueue(app)).toEqual(['posts/dz:1']);
    const doc = (await mod().get(app.id, PUBLISHED_NS, 'posts', 'dz'))!;
    expect({ open: doc.reports, total: doc.reportsTotal }).toEqual({ open: 1, total: 3 });
  });
});

describe('reports through an import keep the report mark’s rule', () => {
  const PUBLISH = 'apps:storage:publish';
  const CONSUMER_SCOPES = ['apps:storage', 'apps:storage:import'];
  const GRANTS_MIGRATION = path.resolve(
    __dirname,
    '../../../../../packages/civitai-db-schema/prisma/migrations/20261218120000_app_storage_import_grants/migration.sql'
  );
  let ledger: PGlite;
  let publishGrants: Set<string>;

  beforeAll(async () => {
    ledger = new PGlite();
    await ledger.exec(`
      CREATE TABLE "User" ("id" integer PRIMARY KEY);
      CREATE TABLE "app_blocks" ("id" text PRIMARY KEY);
    `);
    await ledger.exec(readFileSync(GRANTS_MIGRATION, 'utf8'));
  });
  afterAll(async () => {
    await ledger?.close();
  });
  beforeEach(async () => {
    await ledger.exec(`TRUNCATE "app_storage_import_grants"`);
    publishGrants = new Set();
    dbMock.dbWrite.$queryRaw.mockImplementation(
      async (strings: TemplateStringsArray, ...values: unknown[]) =>
        strings.join('?').includes('app_storage_import_grants')
          ? pgliteRaw(ledger).queryRaw(strings, ...values)
          : []
    );
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockImplementation(
      async ({
        where,
      }: {
        where: { userId_appBlockId: { userId: number; appBlockId: string } };
      }) => {
        const { userId, appBlockId } = where.userId_appBlockId;
        return publishGrants.has(`${userId}|${appBlockId}`)
          ? { grantedScopes: ['apps:storage', PUBLISH], revokedAt: null, revokedScopes: [] }
          : null;
      }
    );
  });

  /** A source app with one shared document, and a consumer importing it at `access`. */
  async function pair(access: 'read' | 'readwrite') {
    const S = freshApp(
      {
        scopes: ['apps:storage', PUBLISH],
        storage: { collections: { board: { visibility: 'shared', write: 'own' } } },
      },
      'rsrc'
    );
    const C = freshApp(
      {
        scopes: CONSUMER_SCOPES,
        storage: {
          collections: { own: { visibility: 'private' } },
          imports: [{ from: S.blockId, collections: ['board'], access }],
        },
      },
      'rcon'
    );
    await ledger.query(`INSERT INTO "User" VALUES ($1) ON CONFLICT DO NOTHING`, [UID.v2]);
    await ledger.exec(
      `INSERT INTO "app_blocks" VALUES ('${C.id}'), ('${S.id}') ON CONFLICT DO NOTHING`
    );
    await recordStorageImportGrants({
      userId: UID.v2,
      consumerAppBlockId: C.id,
      grants: [{ sourceAppBlockId: S.id, collections: ['board'], access }],
    });
    const made = await storage({
      token: await mint(S, UID.v1, ['apps:storage', PUBLISH]),
      method: 'PUT',
      path: '/board/b9',
      body: { data: { title: 'imported' } },
    });
    expect(made.status).toBe(200);
    return { S, C };
  }

  const viaImport = async (C: AppRow, S: AppRow) =>
    report(await mint(C, UID.v2, CONSUMER_SCOPES), {
      collection: 'board',
      key: 'b9',
      from: S.blockId,
    });

  it('a read-only import cannot report (403 write_policy)', async () => {
    const { S, C } = await pair('read');
    publishGrants.add(`${UID.v2}|${S.id}`);
    const r = await viaImport(C, S);
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 403, code: 'write_policy' });
    expect(await reportRows(S, 'b9', 'board')).toEqual({ reporters: [], tally: null });
  });

  it('a readwrite import needs the publish consent in the SOURCE; with it the report is filed there', async () => {
    const { S, C } = await pair('readwrite');
    const refused = await viaImport(C, S);
    expect({
      status: refused.status,
      code: refused.body.code,
      from: (refused.body.details as { from?: string } | undefined)?.from,
    }).toEqual({ status: 403, code: 'consent_required', from: S.blockId });
    expect(await reportRows(S, 'b9', 'board')).toEqual({ reporters: [], tally: null });

    publishGrants.add(`${UID.v2}|${S.id}`);
    const landed = await viaImport(C, S);
    expect({ status: landed.status, body: landed.body }).toEqual({
      status: 200,
      body: { reported: true },
    });
    expect(await reportRows(S, 'b9', 'board')).toEqual({ reporters: [UID.v2], tally: null });
    expect(await openQueue(S)).toEqual(['board/b9:1']);
    // Nothing in the consumer; the report spent the SOURCE's report bucket.
    expect(await harness.raw(`SELECT 1 FROM appdata.doc_mark WHERE app_id = $1`, [C.id])).toEqual(
      []
    );
    expect(
      kv.get(`${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:docs-report:${S.id}:u:${UID.v2}`)?.value
    ).toBe('1');
  });
});
