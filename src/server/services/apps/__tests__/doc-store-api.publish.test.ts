// Setup-order import: installs the env mock with the test RSA keypair BEFORE the block-token
// service and the middleware read it at module load.
import '~/__tests__/setup';
import { Readable } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as FliptClient from '~/server/flipt/client';
import type * as SessionClientModule from '~/server/auth/session-client';
import type * as Moderation from '~/server/services/apps/shared-data-moderation';
import type * as SubListingService from '~/server/services/blocks/app-sub-listing.service';
import type { SharedTextScan } from '~/server/services/apps/shared-data-moderation';
import type { DocStore } from '~/server/services/apps/doc-store';
import { createLuaRedis, type LuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import { createPgliteHarness, type Harness } from './doc-store.harness';

/**
 * Server-side publish and unpublish (`POST /storage/_publish/:to`, `POST /storage/_unpublish/:to`),
 * end to end: a REAL signed block token → the REAL `withBlockScope` → the REAL page handler → the
 * REAL resolver → the REAL document store on an embedded Postgres (the real migration, the
 * least-privilege role, RLS on). Replaced at the boundary only, as in
 * `doc-store-api.contract.test.ts`: the Postgres rows the resolver reads, Redis (an in-memory map
 * plus the Lua harness for the token-bucket script), the session hub, the App Blocks flags, the
 * Flipt flags, and the moderation SCANNER (whose verdict logic stays real).
 *
 * The write budgets are asserted by their Redis hashes with LITERAL values: the Lua clock is fixed
 * at T = 2031-03-04T05:06:07.000Z (1930367167000 ms), so every bucket's "full again" instant is a
 * number written out below, never derived from the constants under test.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({
  store: undefined as unknown as DocStore,
  users: new Map<number, unknown>(),
  moderationMode: 'enforce' as 'off' | 'shadow' | 'enforce',
  publishFlag: true,
  /** Every entity id the publish flag was evaluated for. */
  publishFlagEntities: [] as (string | undefined)[],
  /** Run once, inside the next data scan (between the route's pre-read and its transaction). */
  onScan: null as null | (() => Promise<void>),
  scans: 0,
  /** Every shared-data moderation flag evaluation, by flag. */
  modeFlagLookups: [] as string[],
}));

const SHADOW_FLAG = 'app-blocks-shared-data-moderation';
const ENFORCE_FLAG = 'app-blocks-shared-data-moderation-enforce';
const PUBLISH_FLAG = 'app-blocks-storage-publish';
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const real = await importOriginal<typeof FliptClient>();
  const isFlipt = async (flag: string, entityId?: string, context?: unknown) => {
    if (flag === SHADOW_FLAG || flag === ENFORCE_FLAG) h.modeFlagLookups.push(flag);
    if (flag === SHADOW_FLAG) return h.moderationMode === 'shadow';
    if (flag === ENFORCE_FLAG) return h.moderationMode === 'enforce';
    if (flag === PUBLISH_FLAG) {
      h.publishFlagEntities.push(entityId);
      return h.publishFlag;
    }
    return real.isFlipt(flag, entityId, context as never);
  };
  return { ...real, isFlipt };
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
const cardSync = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('~/server/services/blocks/app-sub-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubListingService>()),
  syncSubListingForSharedRow: vi.fn(async (args: unknown) => {
    cardSync.calls.push(args);
  }),
}));
vi.mock('~/server/services/apps/shared-data-moderation', async (importOriginal) => {
  const real = await importOriginal<typeof Moderation>();
  const verdict = (text: string): SharedTextScan => {
    const leaf = { raw: text, path: 't', segments: ['t'], kind: 'value' as const };
    if (text.includes('publish-blocked-term')) {
      return {
        leafCount: 1,
        overflow: null,
        hits: [{ category: 'audit_regex', matched: 'm', label: 'l', leaf }],
      };
    }
    return { leafCount: 1, overflow: null, hits: [] };
  };
  return {
    ...real,
    scanSharedData: vi.fn(async (data: unknown) => {
      h.scans += 1;
      const hook = h.onScan;
      if (hook) {
        h.onScan = null;
        await hook();
      }
      return verdict(JSON.stringify(data));
    }),
    scanCounterKey: vi.fn(async (key: string) => verdict(key)),
    recordSharedDataScan: vi.fn(async () => undefined),
    scheduleSharedDataShadow: vi.fn(() => undefined),
  };
});

import { BlockTokenService } from '~/server/services/block-token.service';
import { REDIS_KEYS } from '~/server/redis/client';
import { createDocStore } from '~/server/services/apps/doc-store';
import { DEFAULT_DOC_STORE_LIMITS } from '~/server/services/apps/doc-store.types';
import { OnboardingSteps } from '~/server/common/enums';
import { parseManifestStorage } from '~/shared/constants/block-storage.constants';
import storageRoute from '~/pages/api/v1/blocks/storage/[[...path]]';
// Loaded up front: the route reaches this module through `syncStoreItem`'s dynamic import, and
// two such imports racing on a mocked module's FIRST load (an unpublish of two keys syncs two
// cards at once) can hand one of them a module whose export is not set yet; `syncStoreItem`
// swallows that, so one card sync would vanish from the count below. A test-harness effect only.
import { syncSubListingForSharedRow } from '~/server/services/blocks/app-sub-listing.service';

void loggingMock;
void syncSubListingForSharedRow;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T = 1_930_367_167_000; // 2031-03-04T05:06:07.000Z
// Distinctive ids, none of which appears in a fixture value.
const V1 = 813_017;
const V2 = 813_024;
const NEWBIE = 813_031;
const ALL_UIDS = [V1, V2, NEWBIE];
const SCOPES = ['apps:storage', 'apps:storage:publish'];

const OWNED_POINTER = '/mv';
const MV_V1 = 5501;
const MV_V2 = 5502;

const MANIFEST = {
  scopes: SCOPES,
  storage: {
    collections: {
      drafts: { visibility: 'private' },
      notes: { visibility: 'private' },
      clips: {
        visibility: 'shared',
        write: 'own',
        marks: ['vote'],
        indexes: { char: 'string' },
        showAuthor: true,
      },
      titled: {
        visibility: 'shared',
        write: 'own',
        schema: {
          type: 'object',
          required: ['title'],
          properties: { title: { type: 'string', minLength: 1 } },
        },
      },
      picks: { visibility: 'shared', write: 'own', ownedModelVersions: [OWNED_POINTER] },
      plays: { visibility: 'shared', write: 'none', counters: ['plays'] },
    },
  },
};

type AppRow = { id: string; appId: string; blockId: string; status: string; manifest: unknown };
let apps: AppRow[] = [];
let appSeq = 0;

function freshApp(): AppRow {
  appSeq += 1;
  const row = {
    id: `apb_PUB${appSeq}`,
    appId: `appblk-pub${appSeq}`,
    blockId: `publish-${appSeq}`,
    status: 'approved',
    manifest: MANIFEST,
  };
  apps.push(row);
  return row;
}

function user(id: number, trusted: boolean) {
  return {
    id,
    username: `publish_user_${ALL_UIDS.indexOf(id)}`,
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
  lua = createLuaRedis(T);
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
  dbMock.dbRead.user.findMany.mockImplementation(
    async ({ where }: { where: { id: { in: number[] } } }) =>
      [...h.users.values()]
        .map((u) => u as { id: number; username: string })
        .filter((u) => where.id.in.includes(u.id))
        .map((u) => ({ id: u.id, username: u.username }))
  );
  dbMock.dbRead.account.count.mockResolvedValue(0);
  const versions = [
    { id: MV_V1, owner: V1 },
    { id: MV_V2, owner: V2 },
  ];
  dbMock.dbRead.modelVersion.findMany.mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) =>
    versions
      .filter((r) => where.id.in.includes(r.id))
      .map((r) => ({
        id: r.id,
        status: 'Published',
        model: { userId: r.owner, status: 'Published', deletedAt: null },
      }))) as never);
}

// ---------------------------------------------------------------------------
// Driving the route
// ---------------------------------------------------------------------------

type Reply = { status: number; body: unknown; headers: Record<string, unknown> };

async function mint(app: AppRow, uid: number, scopes: string[] = SCOPES): Promise<string> {
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

async function call(opts: {
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
    socket: { remoteAddress: '198.51.100.9' },
  }) as unknown as NextApiRequest;
  const headers: Record<string, unknown> = {};
  let status = 0;
  let body: unknown;
  const res = {
    statusCode: 0,
    status(code: number) {
      status = code;
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
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
  await storageRoute(req, res as unknown as NextApiResponse);
  // No response ever carries a numeric user id.
  const text2 = JSON.stringify(body ?? null);
  for (const uid of ALL_UIDS) expect(text2.includes(String(uid))).toBe(false);
  return { status, body, headers };
}

const putPrivate = (token: string, key: string, data: Record<string, unknown>, coll = 'drafts') =>
  call({ token, method: 'PUT', path: `/${coll}/${key}`, body: { data } });
const publish = (token: string, body: unknown, to = 'clips') =>
  call({ token, method: 'POST', path: `/_publish/${to}`, body });
const unpublish = (token: string, body: unknown, to = 'clips') =>
  call({ token, method: 'POST', path: `/_unpublish/${to}`, body });

async function expectOk(p: Promise<Reply>, status = 200): Promise<Reply> {
  const r = await p;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r;
}

let harness: Harness;
let liveStore: DocStore;
let cappedStore: DocStore;

/** The shared rows of `coll` in an app's production namespace, by key. */
async function sharedRows(app: AppRow, coll = 'clips') {
  return harness.raw(
    `SELECT key, data, version, seq::int AS seq, author_uid, author_kind
       FROM appdata.doc WHERE app_id = $1 AND ns = 'prod' AND coll = $2 AND scope_uid = 0
       ORDER BY key`,
    [app.id, coll]
  );
}

async function lastSeq(app: AppRow): Promise<number> {
  const rows = await harness.raw(
    `SELECT last_seq::int AS s FROM appdata.usage_app WHERE app_id = $1 AND ns = 'prod'`,
    [app.id]
  );
  return Number(rows[0]?.s ?? 0);
}

const budgetKey = (keyspace: string, app: AppRow, uid: number) =>
  `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:${keyspace}:${app.id}:${uid}`;
const publishBudget = (app: AppRow, uid = V1) => lua.hash(budgetKey('docs-publish:v1', app, uid));
const sharedBudget = (app: AppRow, uid = V1) =>
  lua.hash(budgetKey('docs-shared-write:v1', app, uid));

const EMPTY = { created: [], updated: [], unchanged: [], pruned: [], skipped: [] };

beforeAll(async () => {
  harness = await createPgliteHarness({ rls: true });
  liveStore = createDocStore({ db: harness.db });
  cappedStore = createDocStore({
    db: harness.db,
    limits: { ...DEFAULT_DOC_STORE_LIMITS, userDocs: 12 },
  });
  h.store = liveStore;
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(() => {
  apps = [];
  h.store = liveStore;
  h.moderationMode = 'enforce';
  h.publishFlag = true;
  h.publishFlagEntities = [];
  h.onScan = null;
  h.scans = 0;
  h.modeFlagLookups = [];
  cardSync.calls = [];
  h.users.clear();
  h.users.set(V1, user(V1, true));
  h.users.set(V2, user(V2, true));
  h.users.set(NEWBIE, user(NEWBIE, false));
  installRedis();
  installDb();
});

afterEach(() => {
  expect(lua.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fixture', () => {
  it('the manifest is one the parser accepts in full', () => {
    const parsed = parseManifestStorage(MANIFEST);
    expect(parsed.errors).toEqual([]);
  });
});

describe('the flag', () => {
  it('off: both routes answer exactly as an unknown route does, and nothing is written', async () => {
    h.publishFlag = false;
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(putPrivate(t, 'k1', { n: 1 }));
    const unknown = await call({ token: t, method: 'POST', path: '/_nosuchroute/clips', body: {} });
    expect(unknown.status).toBe(404);
    for (const r of [
      await publish(t, { from: 'drafts', keys: ['k1'] }),
      await unpublish(t, { keys: ['k1'] }),
    ]) {
      expect({ status: r.status, body: r.body }).toEqual({
        status: unknown.status,
        body: unknown.body,
      });
    }
    expect(await sharedRows(A)).toEqual([]);
    // Evaluated per app: the entity is the app block id.
    expect(h.publishFlagEntities).toEqual([A.id, A.id]);
  });

  it('off: not a route, so no deprecation headers either', async () => {
    h.publishFlag = false;
    const t = await mint(freshApp(), V1);
    for (const r of [
      await publish(t, { from: 'drafts', keys: ['k1'] }),
      await unpublish(t, { keys: ['k1'] }),
    ]) {
      expect(r.status).toBe(404);
      expect(r.headers.deprecation).toBeUndefined();
      expect(r.headers.link).toBeUndefined();
    }
  });
});

// docs/app-storage-generic-core.md, rollout step 3: server-side publish is being removed; while it
// is served, every response says so (no `Sunset`: removal is gated on measured usage).
describe('deprecation headers', () => {
  const DEPRECATION = '@1794182400';
  const LINK = '<https://developer.civitai.com/apps/guide/storage>; rel="deprecation"';

  it('a publish, an unpublish, a refusal and a wrong method all carry Deprecation and Link', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(putPrivate(t, 'k1', { n: 1 }));
    const replies = [
      await expectOk(publish(t, { from: 'drafts', keys: ['k1'] })),
      await expectOk(unpublish(t, { keys: ['k1'] })),
      // Refused by the body parser (an empty key list).
      await publish(t, { from: 'drafts', keys: [] }),
      await call({ token: t, method: 'GET', path: '/_publish/clips' }),
    ];
    expect(replies.map((r) => r.status)).toEqual([200, 200, 400, 405]);
    for (const r of replies) {
      expect(r.headers.deprecation).toBe(DEPRECATION);
      expect(r.headers.link).toBe(LINK);
      expect(r.headers.sunset).toBeUndefined();
    }
  });

  it('a plain private write beside it carries neither', async () => {
    const t = await mint(freshApp(), V1);
    const r = await expectOk(putPrivate(t, 'k1', { n: 1 }));
    expect(r.headers.deprecation).toBeUndefined();
    expect(r.headers.link).toBeUndefined();
  });
});

describe('publish', () => {
  it("copies the caller's own private documents as user-authored shared documents, each with its own seq", async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(putPrivate(t, 'c1', { char: 'A', n: 1 }));
    await expectOk(putPrivate(t, 'c2', { char: 'A', n: 2 }));
    await expectOk(putPrivate(t, 'c3', { char: 'A', n: 3 }));
    const seqBefore = await lastSeq(A);

    const r = await expectOk(publish(t, { from: 'drafts', keys: ['c3', 'c1', 'c2'] }));
    expect(r.body).toEqual({ ...EMPTY, created: ['c1', 'c2', 'c3'], pruneIncomplete: false });

    const rows = await sharedRows(A);
    expect(rows.map((x) => [x.key, x.data, x.version, x.author_kind, x.author_uid])).toEqual([
      ['c1', { char: 'A', n: 1 }, 1, 'user', V1],
      ['c2', { char: 'A', n: 2 }, 1, 'user', V1],
      ['c3', { char: 'A', n: 3 }, 1, 'user', V1],
    ]);
    // Three new seqs, one per copy, in key order: the registry feed reads them as shared writes.
    expect(rows.map((x) => x.seq)).toEqual([seqBefore + 1, seqBefore + 2, seqBefore + 3]);
    expect(await lastSeq(A)).toBe(seqBefore + 3);

    // Another viewer reads a copy as the owner's document, filterable by its declared index.
    const t2 = await mint(A, V2);
    const got = await call({ token: t2, method: 'GET', path: '/clips/c2' });
    expect(got.body).toMatchObject({
      key: 'c2',
      data: { char: 'A', n: 2 },
      author: { kind: 'user', isViewer: false, username: 'publish_user_0' },
    });
    const listed = await call({
      token: t2,
      method: 'GET',
      path: '/clips',
      query: { 'where[char]': 'A' },
    });
    expect((listed.body as { items: { key: string }[] }).items.map((i) => i.key)).toEqual([
      'c1',
      'c2',
      'c3',
    ]);
  });

  it('re-publish writes only new or changed documents (literal counts)', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    for (const k of ['r1', 'r2', 'r3']) await expectOk(putPrivate(t, k, { k }));
    await expectOk(publish(t, { from: 'drafts', keys: ['r1', 'r2', 'r3'] }));
    const before = await sharedRows(A);
    const seqBefore = await lastSeq(A);

    await expectOk(putPrivate(t, 'r2', { k: 'r2', edited: true }));
    await expectOk(putPrivate(t, 'r4', { k: 'r4' }));
    const seqAfterPrivate = await lastSeq(A);
    expect(seqAfterPrivate).toBe(seqBefore + 2);
    h.scans = 0;
    const r = await expectOk(publish(t, { from: 'drafts', keys: ['r1', 'r2', 'r3', 'r4'] }));
    expect(r.body).toEqual({
      ...EMPTY,
      created: ['r4'],
      updated: ['r2'],
      unchanged: ['r1', 'r3'],
      pruneIncomplete: false,
    });
    // Only the two written documents were scanned, and only they took a seq.
    expect(h.scans).toBe(2);
    expect(await lastSeq(A)).toBe(seqAfterPrivate + 2);
    const after = await sharedRows(A);
    expect(after.map((x) => [x.key, x.version])).toEqual([
      ['r1', 1],
      ['r2', 2],
      ['r3', 1],
      ['r4', 1],
    ]);
    // The unchanged copies were not touched at all.
    expect(after.find((x) => x.key === 'r1')?.seq).toBe(before.find((x) => x.key === 'r1')?.seq);
    expect(after.find((x) => x.key === 'r3')?.seq).toBe(before.find((x) => x.key === 'r3')?.seq);
  });

  it('a publish that changes nothing gives its publish token back', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(putPrivate(t, 'n1', { n: 1 }));
    await expectOk(publish(t, { from: 'drafts', keys: ['n1'] }));
    expect(publishBudget(A)).toEqual({
      b: '1930375807000',
      d: '1930375807000',
      r: '1930367167000',
    });
    const r = await expectOk(publish(t, { from: 'drafts', keys: ['n1'] }));
    expect(r.body).toEqual({ ...EMPTY, unchanged: ['n1'], pruneIncomplete: false });
    expect(publishBudget(A)).toEqual({
      b: '1930375807000',
      d: '1930375807000',
      r: '1930367167000',
    });
  });

  it('spends the publish budget and NOT the 30/300 shared write budget', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    // One ad-hoc shared write first, so the shared bucket holds literal state to compare.
    await expectOk(
      call({ token: t, method: 'PUT', path: '/clips/adhoc', body: { data: { a: 1 } } })
    );
    const SHARED_AFTER_ONE_WRITE = {
      b: '1930367227000', // T + 60 s: one burst token out of 30
      d: '1930367455000', // T + 288 s: one daily token out of 300
      r: '1930367167000',
    };
    expect(sharedBudget(A)).toEqual(SHARED_AFTER_ONE_WRITE);
    expect(publishBudget(A)).toBeUndefined();

    for (const k of ['s1', 's2', 's3']) await expectOk(putPrivate(t, k, { k }));
    const r = await expectOk(publish(t, { from: 'drafts', keys: ['s1', 's2', 's3'] }));
    expect((r.body as { created: string[] }).created).toEqual(['s1', 's2', 's3']);

    expect(sharedBudget(A)).toEqual(SHARED_AFTER_ONE_WRITE);
    expect(publishBudget(A)).toEqual({
      b: '1930375807000', // T + 2.4 h: one publish out of 10
      d: '1930375807000',
      r: '1930367167000',
    });
  });

  it('allows 10 publishes, then refuses the 11th with 429 and a retryAfter', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    for (let i = 0; i < 10; i++) {
      await expectOk(putPrivate(t, `b${i}`, { i }));
      await expectOk(publish(t, { from: 'drafts', keys: [`b${i}`] }));
    }
    await expectOk(putPrivate(t, 'b10', { i: 10 }));
    const refused = await publish(t, { from: 'drafts', keys: ['b10'] });
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({
      code: 'rate_limited',
      details: { bucket: 'publish', retryAfter: 8640 },
    });
    expect(refused.headers['retry-after']).toBe('8640');
    expect((await sharedRows(A)).map((x) => x.key)).not.toContain('b10');
  });

  it('refuses a key list over 500, an empty one and a duplicate, before spending anything', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    const evals = lua.calls.length;
    const over = Array.from({ length: 501 }, (_, i) => `k${i}`);
    const cases: [unknown, Record<string, unknown>][] = [
      [
        { from: 'drafts', keys: over },
        { reason: 'too_many_keys', max: 500 },
      ],
      [{ from: 'drafts', keys: [] }, { reason: 'empty_keys' }],
      [
        { from: 'drafts', keys: ['a', 'b', 'a'] },
        { reason: 'duplicate_key', key: 'a' },
      ],
    ];
    for (const [body, details] of cases) {
      const r = await publish(t, body);
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ code: 'invalid_request', details });
    }
    for (const [body, details] of [
      [{ keys: over }, { reason: 'too_many_keys', max: 500 }],
      [{ keys: [] }, { reason: 'empty_keys' }],
      [{ keys: ['a', 'a'] }, { reason: 'duplicate_key', key: 'a' }],
    ] as const) {
      const r = await unpublish(t, body);
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ code: 'invalid_request', details });
    }
    expect(lua.calls.length).toBe(evals);
    // Exactly 500 is accepted (every key missing here, so nothing is written).
    const ok = await expectOk(
      publish(t, { from: 'drafts', keys: Array.from({ length: 500 }, (_, i) => `k${i}`) })
    );
    expect((ok.body as { skipped: unknown[] }).skipped).toHaveLength(500);
  });

  it('skips and reports a key with no private document; the rest lands', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(putPrivate(t, 'here', { x: 1 }));
    const r = await expectOk(publish(t, { from: 'drafts', keys: ['ghost', 'here'] }));
    expect(r.body).toEqual({
      ...EMPTY,
      created: ['here'],
      skipped: [{ key: 'ghost', reason: 'missing' }],
      pruneIncomplete: false,
    });
  });

  it("never reaches another user's private documents", async () => {
    const A = freshApp();
    const t1 = await mint(A, V1);
    const t2 = await mint(A, V2);
    await expectOk(putPrivate(t2, 'theirs', { secret: 'v2-only' }));
    await expectOk(putPrivate(t2, 'both', { secret: 'v2-both' }));
    await expectOk(putPrivate(t1, 'both', { mine: 'v1-both' }));

    const r = await expectOk(publish(t1, { from: 'drafts', keys: ['both', 'theirs'] }));
    expect(r.body).toEqual({
      ...EMPTY,
      created: ['both'],
      skipped: [{ key: 'theirs', reason: 'missing' }],
      pruneIncomplete: false,
    });
    const rows = await sharedRows(A);
    expect(rows.map((x) => [x.key, x.data, x.author_uid])).toEqual([
      ['both', { mine: 'v1-both' }, V1],
    ]);
    expect(JSON.stringify(rows)).not.toContain('v2-');
  });

  it('skips a key whose shared copy another user authored, and leaves that copy as it was', async () => {
    const A = freshApp();
    const t1 = await mint(A, V1);
    const t2 = await mint(A, V2);
    await expectOk(putPrivate(t2, 'taken', { by: 'v2' }));
    await expectOk(publish(t2, { from: 'drafts', keys: ['taken'] }));
    await expectOk(putPrivate(t1, 'taken', { by: 'v1' }));
    await expectOk(putPrivate(t1, 'free', { by: 'v1' }));

    const r = await expectOk(publish(t1, { from: 'drafts', keys: ['free', 'taken'] }));
    expect(r.body).toEqual({
      ...EMPTY,
      created: ['free'],
      skipped: [{ key: 'taken', reason: 'not_author' }],
      pruneIncomplete: false,
    });
    const rows = await sharedRows(A);
    expect(rows.map((x) => [x.key, x.data, x.version, x.author_uid])).toEqual([
      ['free', { by: 'v1' }, 1, V1],
      ['taken', { by: 'v2' }, 1, V2],
    ]);
  });

  it('skips a copy a moderator hid, as `hidden`, and never rewrites it', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(putPrivate(t, 'hid', { v: 1 }));
    await expectOk(publish(t, { from: 'drafts', keys: ['hid'] }));
    await harness.raw(
      `UPDATE appdata.doc SET hidden_at = now() WHERE app_id = $1 AND ns = 'prod'
         AND coll = 'clips' AND scope_uid = 0 AND key = 'hid'`,
      [A.id]
    );
    await expectOk(putPrivate(t, 'hid', { v: 2 }));
    const seq = await lastSeq(A);
    h.scans = 0;
    const r = await expectOk(publish(t, { from: 'drafts', keys: ['hid'] }));
    expect(r.body).toEqual({
      ...EMPTY,
      skipped: [{ key: 'hid', reason: 'hidden' }],
      pruneIncomplete: false,
    });
    expect(h.scans).toBe(0);
    expect(await lastSeq(A)).toBe(seq);
    const rows = await sharedRows(A);
    expect(rows.map((x) => [x.key, x.data, x.version])).toEqual([['hid', { v: 1 }, 1]]);
  });

  it('copies count against the owner’s document cap', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    for (const k of ['u1', 'u2', 'u3']) await expectOk(putPrivate(t, k, { k }));
    await expectOk(publish(t, { from: 'drafts', keys: ['u1', 'u2', 'u3'] }));
    const info = await call({ token: t, method: 'GET', path: '' });
    expect((info.body as { usage: { viewer: { docs: number } } }).usage.viewer.docs).toBe(6);
  });

  it('a publish the document cap cannot hold is refused whole: nothing is written', async () => {
    h.store = cappedStore; // 12 documents per user
    const A = freshApp();
    const t = await mint(A, V1);
    const keys = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'];
    for (const k of keys) await expectOk(putPrivate(t, k, { k }));
    const seq = await lastSeq(A);
    // 7 private + 7 copies = 14 > 12.
    const r = await publish(t, { from: 'drafts', keys });
    expect(r.status).toBe(413);
    expect(r.body).toMatchObject({ code: 'quota_exceeded', details: { ceiling: 'author' } });
    expect(await sharedRows(A)).toEqual([]);
    expect(await lastSeq(A)).toBe(seq);
    const info = await call({ token: t, method: 'GET', path: '' });
    expect((info.body as { usage: { viewer: { docs: number } } }).usage.viewer.docs).toBe(7);
    // 7 private + 5 copies = 12: exactly at the cap, accepted.
    const ok = await expectOk(publish(t, { from: 'drafts', keys: keys.slice(0, 5) }));
    expect((ok.body as { created: string[] }).created).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
  });

  it('a moderation hit on one document refuses the whole publish, naming the key', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(putPrivate(t, 'm1', { t: 'fine' }));
    await expectOk(putPrivate(t, 'm2', { t: 'has publish-blocked-term inside' }));
    await expectOk(putPrivate(t, 'm3', { t: 'fine too' }));
    const r = await publish(t, { from: 'drafts', keys: ['m1', 'm2', 'm3'] });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({
      code: 'content_rejected',
      details: { category: 'blocked', key: 'm2' },
    });
    expect(await sharedRows(A)).toEqual([]);
  });

  it('resolves the moderation mode once per publish, not once per document', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    for (const k of ['o1', 'o2', 'o3']) await expectOk(putPrivate(t, k, { k }));
    h.modeFlagLookups = [];
    h.scans = 0;
    const r = await expectOk(publish(t, { from: 'drafts', keys: ['o1', 'o2', 'o3'] }));
    expect((r.body as { created: string[] }).created).toEqual(['o1', 'o2', 'o3']);
    // Every document is still scanned; the two mode flags are each evaluated once.
    expect(h.scans).toBe(3);
    expect([...h.modeFlagLookups].sort()).toEqual([SHADOW_FLAG, ENFORCE_FLAG]);
  });

  it('in shadow moderation the same batch lands (scanned after the write)', async () => {
    h.moderationMode = 'shadow';
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(putPrivate(t, 'm1', { t: 'fine' }));
    await expectOk(putPrivate(t, 'm2', { t: 'has publish-blocked-term inside' }));
    const r = await expectOk(publish(t, { from: 'drafts', keys: ['m1', 'm2'] }));
    expect((r.body as { created: string[] }).created).toEqual(['m1', 'm2']);
  });

  it("validates every copy against the TARGET collection's schema", async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(putPrivate(t, 'ok', { title: 'Named' }));
    await expectOk(putPrivate(t, 'bad', { untitled: true }));
    const r = await publish(t, { from: 'drafts', keys: ['bad', 'ok'] }, 'titled');
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'schema_violation' });
    expect(await sharedRows(A, 'titled')).toEqual([]);
  });

  it("applies the target collection's ownedModelVersions rule to every copy", async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(putPrivate(t, 'own', { mv: MV_V1 }));
    await expectOk(putPrivate(t, 'other', { mv: MV_V2 }));
    const r = await publish(t, { from: 'drafts', keys: ['other', 'own'] }, 'picks');
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'resource_not_owned' });
    expect(await sharedRows(A, 'picks')).toEqual([]);
    const ok = await expectOk(publish(t, { from: 'drafts', keys: ['own'] }, 'picks'));
    expect((ok.body as { created: string[] }).created).toEqual(['own']);
  });

  it('a private document changed after it was checked refuses the publish 409 source_changed', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(putPrivate(t, 'sc1', { v: 1 }));
    await expectOk(putPrivate(t, 'sc2', { v: 1 }));
    // Inside the scan — after the route read and checked the documents, before its transaction.
    h.onScan = async () => {
      await liveStore.put(
        { appId: A.id, ns: 'prod', viewerUid: V1 },
        { name: 'drafts', config: parseManifestStorage(MANIFEST).collections.get('drafts')! },
        'sc2',
        { v: 2, sneaked: 'publish-blocked-term' }
      );
    };
    const r = await publish(t, { from: 'drafts', keys: ['sc1', 'sc2'] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      code: 'version_conflict',
      details: { reason: 'source_changed', key: 'sc2' },
    });
    expect(await sharedRows(A)).toEqual([]);
  });

  it("a key that was another author's at the check and is free under lock refuses 409 target_changed, with no rejection token", async () => {
    const A = freshApp();
    const t1 = await mint(A, V1);
    const t2 = await mint(A, V2);
    await expectOk(putPrivate(t2, 'taken', { by: 'v2' }));
    await expectOk(publish(t2, { from: 'drafts', keys: ['taken'] }));
    await expectOk(putPrivate(t1, 'mine', { by: 'v1' }));
    await expectOk(putPrivate(t1, 'taken', { by: 'v1' }));
    const clips = {
      name: 'clips',
      config: parseManifestStorage(MANIFEST).collections.get('clips')!,
    };
    // Inside the scan of `mine`: the other author withdraws `taken`, which the check saw as theirs.
    h.onScan = async () => {
      await liveStore.delete({ appId: A.id, ns: 'prod', viewerUid: V2 }, clips, 'taken');
    };
    const r = await publish(t1, { from: 'drafts', keys: ['mine', 'taken'] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      code: 'version_conflict',
      details: { reason: 'target_changed', key: 'taken' },
    });
    expect(await sharedRows(A)).toEqual([]);
    // The publish token went back and no rejection token was charged: the bucket is full again.
    expect(publishBudget(A, V1)).toBeUndefined();
  });

  it('every publish call spends one write-bucket token before any read, even one that changes nothing', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(putPrivate(t, 'w1', { w: 1 }));
    await expectOk(publish(t, { from: 'drafts', keys: ['w1'] }));
    const writeKey = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:docs-write:${A.id}:u:${V1}`;
    // One private put and one publish so far.
    expect(kv.get(writeKey)?.value).toBe('2');
    const r = await expectOk(publish(t, { from: 'drafts', keys: ['w1'] }));
    expect(r.body).toEqual({ ...EMPTY, unchanged: ['w1'], pruneIncomplete: false });
    expect(kv.get(writeKey)?.value).toBe('3');
  });

  it('a loop of publishes that change nothing is refused 429 by the write bucket', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(putPrivate(t, 'l1', { l: 1 }));
    await expectOk(publish(t, { from: 'drafts', keys: ['l1'] }));
    const writeKey = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:docs-write:${A.id}:u:${V1}`;
    // 118 of the 120 a minute already spent.
    kv.set(writeKey, { value: '118', ttl: 60 });
    const statuses: number[] = [];
    let last: Reply | undefined;
    for (let i = 0; i < 3; i++) {
      last = await publish(t, { from: 'drafts', keys: ['l1'] });
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(last?.body).toMatchObject({
      code: 'rate_limited',
      details: { bucket: 'write', retryAfter: 60 },
    });
  });

  it('refuses a private target, a shared source, an undeclared source and a counter-only target', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    const cases: [unknown, string, number, string][] = [
      [{ from: 'drafts', keys: ['a'] }, 'notes', 400, 'invalid_request'],
      [{ from: 'clips', keys: ['a'] }, 'titled', 400, 'invalid_request'],
      [{ from: 'nope', keys: ['a'] }, 'clips', 404, 'collection_not_declared'],
      [{ from: 'drafts', keys: ['a'] }, 'plays', 403, 'write_policy'],
    ];
    for (const [body, to, status, code] of cases) {
      const r = await publish(t, body, to);
      expect([to, r.status, (r.body as { code: string }).code]).toEqual([to, status, code]);
    }
  });

  it('needs the publish consent and the min-trust gate', async () => {
    const A = freshApp();
    const noPublish = await mint(A, V1, ['apps:storage']);
    const r1 = await publish(noPublish, { from: 'drafts', keys: ['a'] });
    expect(r1.status).toBe(403);
    expect(r1.body).toMatchObject({ code: 'consent_required' });
    const newbie = await mint(A, NEWBIE);
    const r2 = await publish(newbie, { from: 'drafts', keys: ['a'] });
    expect(r2.status).toBe(403);
    expect(r2.body).toMatchObject({ code: 'not_eligible' });
  });
});

describe('prune', () => {
  async function twoCharacters() {
    const A = freshApp();
    const t1 = await mint(A, V1);
    const t2 = await mint(A, V2);
    for (const k of ['A:1', 'A:2', 'B:1', 'B:2']) {
      await expectOk(putPrivate(t1, k, { char: k[0], k }));
    }
    await expectOk(publish(t1, { from: 'drafts', keys: ['A:1', 'A:2'] }));
    await expectOk(publish(t1, { from: 'drafts', keys: ['B:1', 'B:2'] }));
    // Another user's copy under a key the caller has no private document for.
    await expectOk(putPrivate(t2, 'A:9', { by: 'v2' }));
    await expectOk(publish(t2, { from: 'drafts', keys: ['A:9'] }));
    return { A, t1, t2 };
  }

  it("publishing character A with prune leaves character B's copies untouched", async () => {
    const { A, t1 } = await twoCharacters();
    await expectOk(call({ token: t1, method: 'DELETE', path: '/drafts/A:2' }));
    const r = await expectOk(publish(t1, { from: 'drafts', keys: ['A:1'], prune: true }));
    expect(r.body).toEqual({
      ...EMPTY,
      unchanged: ['A:1'],
      pruned: ['A:2'],
      pruneIncomplete: false,
    });
    expect((await sharedRows(A)).map((x) => [x.key, x.author_uid])).toEqual([
      ['A:1', V1],
      ['A:9', V2],
      ['B:1', V1],
      ['B:2', V1],
    ]);
  });

  it('a pruned copy takes one seq and leaves a tombstone, like any delete', async () => {
    const { A, t1 } = await twoCharacters();
    await expectOk(call({ token: t1, method: 'DELETE', path: '/drafts/A:2' }));
    const seq = await lastSeq(A);
    const r = await expectOk(publish(t1, { from: 'drafts', keys: ['A:1'], prune: true }));
    expect(r.body).toEqual({
      ...EMPTY,
      unchanged: ['A:1'],
      pruned: ['A:2'],
      pruneIncomplete: false,
    });
    // A pruned copy takes one seq (its tombstone), like any delete.
    expect(await lastSeq(A)).toBe(seq + 1);
    const tombs = await harness.raw(
      `SELECT key FROM appdata.doc_tomb WHERE app_id = $1 AND ns = 'prod' AND coll = 'clips'`,
      [A.id]
    );
    expect(tombs.map((x) => x.key)).toEqual(['A:2']);
    expect((await sharedRows(A)).map((x) => x.key)).toEqual(['A:1', 'A:9', 'B:1', 'B:2']);
  });

  it('a prune never deletes a copy another user authored', async () => {
    const { A, t1 } = await twoCharacters();
    await expectOk(call({ token: t1, method: 'DELETE', path: '/drafts/A:1' }));
    await expectOk(call({ token: t1, method: 'DELETE', path: '/drafts/A:2' }));
    await expectOk(putPrivate(t1, 'A:3', { char: 'A', k: 'A:3' }));
    const r = await expectOk(publish(t1, { from: 'drafts', keys: ['A:3'], prune: true }));
    expect(r.body).toEqual({
      ...EMPTY,
      created: ['A:3'],
      pruned: ['A:1', 'A:2'],
      pruneIncomplete: false,
    });
    expect((await sharedRows(A)).map((x) => [x.key, x.author_uid])).toEqual([
      ['A:3', V1],
      ['A:9', V2],
      ['B:1', V1],
      ['B:2', V1],
    ]);
  });

  it("is scoped by `from`: a prune from one private collection deletes the caller's copies published from another", async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(putPrivate(t, 'd1', { src: 'drafts' }));
    await expectOk(putPrivate(t, 'n1', { src: 'notes' }, 'notes'));
    await expectOk(publish(t, { from: 'drafts', keys: ['d1'] }));
    await expectOk(publish(t, { from: 'notes', keys: ['n1'] }));
    expect((await sharedRows(A)).map((x) => x.key)).toEqual(['d1', 'n1']);
    // `n1` still has its private document — in `notes`, not in `drafts`.
    const r = await expectOk(publish(t, { from: 'drafts', keys: ['d1'], prune: true }));
    expect(r.body).toEqual({
      ...EMPTY,
      unchanged: ['d1'],
      pruned: ['n1'],
      pruneIncomplete: false,
    });
    expect((await sharedRows(A)).map((x) => x.key)).toEqual(['d1']);
  });

  it('takes no prunePrefix (an unknown body field)', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    const r = await publish(t, { from: 'drafts', keys: ['a'], prune: true, prunePrefix: 'A:' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'invalid_request' });
  });
});

describe('unpublish', () => {
  it("deletes only the caller's own copies in one call, on the write bucket, not either budget", async () => {
    const A = freshApp();
    const t1 = await mint(A, V1);
    const t2 = await mint(A, V2);
    for (const k of ['x1', 'x2']) await expectOk(putPrivate(t1, k, { k }));
    await expectOk(publish(t1, { from: 'drafts', keys: ['x1', 'x2'] }));
    await expectOk(putPrivate(t2, 'theirs', { by: 'v2' }));
    await expectOk(publish(t2, { from: 'drafts', keys: ['theirs'] }));
    const shared = sharedBudget(A);
    const published = publishBudget(A);
    const writeKey = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:docs-write:${A.id}:u:${V1}`;
    const writesBefore = Number(kv.get(writeKey)?.value ?? 0);
    const seq = await lastSeq(A);

    const r = await expectOk(unpublish(t1, { keys: ['ghost', 'theirs', 'x1', 'x2'] }));
    expect(r.body).toEqual({
      deleted: ['x1', 'x2'],
      skipped: [
        { key: 'ghost', reason: 'missing' },
        { key: 'theirs', reason: 'not_author' },
      ],
    });
    expect((await sharedRows(A)).map((x) => [x.key, x.author_uid])).toEqual([['theirs', V2]]);
    expect(Number(kv.get(writeKey)?.value)).toBe(writesBefore + 1);
    expect(sharedBudget(A)).toEqual(shared);
    expect(publishBudget(A)).toEqual(published);
    expect(await lastSeq(A)).toBe(seq + 2);
    // The App Store card follows each removed item, as a single delete's does.
    const failedSyncs = loggingMock.logToAxiom.mock.calls.filter(
      ([e]) => (e as { name?: string } | undefined)?.name === 'app-sub-listing-shared-sync-failed'
    );
    expect(failedSyncs).toEqual([]);
    // One sync for the whole unpublish: one parent lookup, the keys batched.
    expect(cardSync.calls).toEqual([
      { appBlockId: A.id, itemKey: ['x1', 'x2'], change: 'withdrawn', authorUserId: V1 },
    ]);
  });
});

describe('the store: prune is bounded per call', () => {
  it('stops at its limit and says so; the next call continues', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    const keys = ['p1', 'p2', 'p3', 'p4', 'p5'];
    for (const k of keys) await expectOk(putPrivate(t, k, { k }));
    await expectOk(publish(t, { from: 'drafts', keys }));
    for (const k of ['p1', 'p2', 'p3', 'p4']) {
      await expectOk(call({ token: t, method: 'DELETE', path: `/drafts/${k}` }));
    }
    const decls = parseManifestStorage(MANIFEST).collections;
    const ctx = { appId: A.id, ns: 'prod', viewerUid: V1 };
    const drafts = { name: 'drafts', config: decls.get('drafts')! };
    const clips = { name: 'clips', config: decls.get('clips')! };
    const run = () =>
      liveStore.publishCopies(ctx, drafts, clips, {
        keys: ['p5'],
        checked: new Map(),
        prune: { limit: 3 },
      });
    expect(await run()).toEqual({
      ...EMPTY,
      unchanged: ['p5'],
      pruned: ['p1', 'p2', 'p3'],
      pruneIncomplete: true,
    });
    expect(await run()).toEqual({
      ...EMPTY,
      unchanged: ['p5'],
      pruned: ['p4'],
      pruneIncomplete: false,
    });
    expect((await sharedRows(A)).map((x) => x.key)).toEqual(['p5']);
  });
});

describe('publish refuses orchestrator media links in every moderation mode', () => {
  it.each(['off', 'shadow'] as const)(
    'a private draft holding a consumer-blob url saves, but publishing it is refused (%s)',
    async (mode) => {
      h.moderationMode = mode;
      const A = freshApp();
      const t = await mint(A, V1);
      const blob = 'https://orchestration.civitai.com/v2/consumer/blobs/PUB123.png?sig=s';
      await expectOk(putPrivate(t, 'c1', { char: 'A', img: blob }));
      const r = await publish(t, { from: 'drafts', keys: ['c1'] });
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ code: 'content_rejected' });
      expect(await sharedRows(A)).toEqual([]);
    }
  );
});
