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
 * VIEWER-KEYED DOCUMENTS (docs/app-storage-generic-core.md, "Viewer-keyed documents"), end to end
 * as `doc-store-api.unchanged-writes.test.ts` drives the route: a REAL signed block token → the
 * REAL route → the REAL document store on an embedded Postgres (RLS on). Replaced at the boundary
 * only: the Postgres rows the resolver reads, Redis, the session hub, the App Blocks and Flipt
 * flags, and the moderation SCANNER (its verdict logic stays real; the keys it is handed are
 * recorded).
 *
 * Fixtures are pairwise distinct: two viewers with ids that appear nowhere else, parents that
 * are not prefixes of each other, and collections whose names match no parent.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({
  store: undefined as unknown as DocStore,
  users: new Map<number, unknown>(),
  /** The viewer-keyed switch, by collection (absent: closed). */
  open: new Map<string, boolean>(),
  /** Every (entityId, context) the switch was evaluated with. */
  openEvaluations: [] as { entityId?: string; context?: unknown }[],
  /** Every key handed to the key scan. */
  keyScans: [] as string[],
}));

const SHADOW_FLAG = 'app-blocks-shared-data-moderation';
const ENFORCE_FLAG = 'app-blocks-shared-data-moderation-enforce';
const LEVELS_FLAG = 'app-blocks-shared-doc-levels';
const OPEN_FLAG = 'app-blocks-storage-viewer-keyed-open';
const PUBLISH_FLAG = 'app-blocks-storage-publish';
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const real = await importOriginal<typeof FliptClient>();
  const isFlipt = async (flag: string, entityId?: string, context?: unknown) => {
    if (flag === SHADOW_FLAG) return false;
    if (flag === ENFORCE_FLAG) return true;
    if (flag === LEVELS_FLAG) return false;
    // On, so `_publish` / `_unpublish` are routes and their viewer-keyed refusal is reachable.
    if (flag === PUBLISH_FLAG) return true;
    if (flag === OPEN_FLAG) {
      h.openEvaluations.push({ entityId, context });
      const collection = (context as { collection?: string } | undefined)?.collection ?? '';
      return h.open.get(collection) ?? false;
    }
    return real.isFlipt(flag, entityId, context as never);
  };
  return { ...real, isFlipt, readFliptBoolean: isFlipt };
});
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksRuntimeEnabled: vi.fn(async () => true),
  isAppBlocksEnabled: vi.fn(async () => true),
  isAppBlocksAuthorEnabled: vi.fn(async () => true),
}));
vi.mock('~/server/auth/session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionClientModule>()),
  sessionClient: {
    getSessionUserById: vi.fn(async (id: number) => h.users.get(id) ?? null),
  },
}));
vi.mock('~/server/services/apps/doc-store.instance', () => ({ getDocStore: () => h.store }));
vi.mock('~/server/services/blocks/app-sub-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubListingService>()),
  syncSubListingForSharedRow: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/apps/shared-data-moderation', async (importOriginal) => {
  const real = await importOriginal<typeof Moderation>();
  const verdict = (text: string): SharedTextScan => {
    const leaf = { raw: text, path: 't', segments: ['t'], kind: 'value' as const };
    if (text.includes('vkblockedterm')) {
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
    scanSharedData: vi.fn(async (data: unknown) => verdict(JSON.stringify(data))),
    scanCounterKey: vi.fn(async (key: string) => {
      h.keyScans.push(key);
      return verdict(key);
    }),
    recordSharedDataScan: vi.fn(async () => undefined),
    scheduleSharedDataShadow: vi.fn(() => undefined),
  };
});

import { BlockTokenService } from '~/server/services/block-token.service';
import { createDocStore } from '~/server/services/apps/doc-store';
import type { DocCollection } from '~/server/services/apps/doc-store.types';
import { OnboardingSteps } from '~/server/common/enums';
import storageRoute from '~/pages/api/v1/blocks/storage/[[...path]]';
import { envMock } from '~/__tests__/mocks/env.mock';

void loggingMock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T = 1_930_367_167_000; // 2031-03-04T05:06:07.000Z
// Distinctive ids, none of which appears in a fixture value.
const V1 = 731_903;
const V2 = 731_946;
const ALL_UIDS = [V1, V2];
const SCOPES = ['apps:storage', 'apps:storage:publish'];
const SECRET = 'viewer-keyed-test-secret-5f0c9a7e2b';
const P1 = '01JD3Q8M5Z4X2V7K9C6B1N0RTA';
const P2 = 'record-two';
const DIGEST = /^[a-z2-7]{26}$/;

const MANIFEST = {
  scopes: SCOPES,
  storage: {
    collections: {
      votes: { visibility: 'shared', write: 'own', keyedBy: 'parent+viewer' },
      likes: { visibility: 'shared', write: 'own', keyedBy: 'viewer' },
      records: { visibility: 'shared', write: 'own' },
      drafts: { visibility: 'private' },
      plays: { visibility: 'shared', write: 'none', counters: ['plays'] },
    },
  },
};

type AppRow = { id: string; appId: string; blockId: string; status: string; manifest: unknown };
let apps: AppRow[] = [];
let appSeq = 0;

function freshApp(manifest: unknown = MANIFEST): AppRow {
  appSeq += 1;
  const row = {
    id: `apb_VKEY${appSeq}`,
    appId: `appblk-vkey${appSeq}`,
    blockId: `viewer-keyed-${appSeq}`,
    status: 'approved',
    manifest,
  };
  apps.push(row);
  return row;
}

function user(id: number) {
  return {
    id,
    username: `viewer_keyed_user_${ALL_UIDS.indexOf(id)}`,
    createdAt: new Date('2020-01-01T00:00:00Z'),
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
}

// ---------------------------------------------------------------------------
// Driving the route
// ---------------------------------------------------------------------------

type Reply = { status: number; body: unknown };
type Doc = { key: string; data: Record<string, unknown>; version: number };

async function mint(app: AppRow, uid: number | null): Promise<string> {
  const { token } = await BlockTokenService.sign({
    userId: uid,
    blockId: app.blockId,
    appId: app.appId,
    appBlockId: app.id,
    blockInstanceId: `bki_${app.id}`,
    scopes: SCOPES,
    ctx: {},
    maxBrowsingLevel: 1,
    domain: 'green',
  });
  return token;
}

async function call(
  token: string,
  method: string,
  segments: string[],
  opts: { body?: unknown; query?: Record<string, string> } = {}
): Promise<Reply> {
  const text = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const req = Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {
    method,
    url: `/api/v1/blocks/storage/${segments.join('/')}`,
    query: { ...(segments.length ? { path: segments } : {}), ...opts.query },
    headers: { authorization: `Bearer ${token}` },
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
  return { status, body };
}

const me = (coll: string, parent?: string) =>
  parent === undefined ? [coll, '@me'] : [coll, '@me', parent];
const putMine = (
  t: string,
  coll: string,
  parent: string | undefined,
  data: object,
  ifVersion?: number
) =>
  call(t, 'PUT', me(coll, parent), {
    body: ifVersion === undefined ? { data } : { data, ifVersion },
  });
const getMine = (t: string, coll: string, parent?: string) => call(t, 'GET', me(coll, parent));
const deleteMine = (t: string, coll: string, parent?: string) =>
  call(t, 'DELETE', me(coll, parent));

async function expectOk(p: Promise<Reply>, status = 200): Promise<Reply> {
  const r = await p;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r;
}

async function expectRefused(p: Promise<Reply>, status: number, code: string, reason?: string) {
  const r = await p;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body).toMatchObject({ code, ...(reason ? { details: { reason } } : {}) });
  return r;
}

let harness: Harness;

/** Every stored (live) row of a collection: key, data, version, author. */
async function rows(app: AppRow, coll: string) {
  return harness.raw(
    `SELECT key, data, version::int AS version, author_uid::int AS author_uid
       FROM appdata.doc WHERE app_id = $1 AND ns = 'prod' AND coll = $2 AND scope_uid = 0
       ORDER BY key`,
    [app.id, coll]
  );
}

beforeAll(async () => {
  harness = await createPgliteHarness({ rls: true });
  h.store = createDocStore({ db: harness.db });
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(() => {
  apps = [];
  h.open = new Map([
    ['votes', true],
    ['likes', true],
  ]);
  h.openEvaluations = [];
  h.keyScans = [];
  h.users.clear();
  h.users.set(V1, user(V1));
  h.users.set(V2, user(V2));
  envMock.set({ APP_STORAGE_VIEWER_KEY_SECRET: SECRET });
  installRedis();
  installDb();
});

afterEach(() => {
  envMock.set({ APP_STORAGE_VIEWER_KEY_SECRET: undefined });
  expect(lua.errors).toEqual([]);
  expect(harness.violations).toEqual([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parent+viewer: one document per viewer per parent', () => {
  it('🔴 two viewers on one parent get different keys, and neither can touch the other’s', async () => {
    const A = freshApp();
    const [t1, t2] = [await mint(A, V1), await mint(A, V2)];
    const mine1 = (await expectOk(putMine(t1, 'votes', P1, { value: 1 }))).body as Doc;
    const mine2 = (await expectOk(putMine(t2, 'votes', P1, { value: -1 }))).body as Doc;
    expect(mine1.key.startsWith(`${P1}:`)).toBe(true);
    expect(mine2.key.startsWith(`${P1}:`)).toBe(true);
    expect(mine1.key.slice(P1.length + 1)).toMatch(DIGEST);
    expect(mine2.key.slice(P1.length + 1)).toMatch(DIGEST);
    expect(mine1.key).not.toBe(mine2.key);
    // No response carries a numeric user id: the key is a digest of it.
    for (const uid of ALL_UIDS) expect(JSON.stringify([mine1, mine2])).not.toContain(String(uid));

    // Each `@me` reaches only its own viewer's document.
    expect(((await expectOk(getMine(t1, 'votes', P1))).body as Doc).data).toEqual({ value: 1 });
    expect(((await expectOk(getMine(t2, 'votes', P1))).body as Doc).data).toEqual({ value: -1 });

    // Viewer 2 cannot reach viewer 1's document by its key: writes by key are refused outright.
    await expectRefused(
      call(t2, 'PUT', ['votes', mine1.key], { body: { data: { value: -1 } } }),
      400,
      'invalid_request',
      'viewer_keyed'
    );
    await expectRefused(
      call(t2, 'DELETE', ['votes', mine1.key]),
      400,
      'invalid_request',
      'viewer_keyed'
    );

    // Viewer 2 deleting their own leaves viewer 1's.
    expect((await expectOk(deleteMine(t2, 'votes', P1))).body).toEqual({ deleted: true });
    await expectRefused(getMine(t2, 'votes', P1), 404, 'not_found');
    expect(await rows(A, 'votes')).toEqual([
      { key: mine1.key, data: { value: 1 }, version: 1, author_uid: V1 },
    ]);
  });

  it('the same viewer and parent address one stable document; ifVersion applies as to a put', async () => {
    const A = freshApp();
    const t1 = await mint(A, V1);
    const first = (await expectOk(putMine(t1, 'votes', P1, { value: 1 }))).body as Doc;
    const again = (await expectOk(putMine(t1, 'votes', P1, { value: 0 }))).body as Doc;
    expect(again.key).toBe(first.key);
    expect(again.version).toBe(2);
    // A second token for the same viewer derives the same key.
    const fresh = (await expectOk(getMine(await mint(A, V1), 'votes', P1))).body as Doc;
    expect(fresh).toMatchObject({ key: first.key, data: { value: 0 }, version: 2 });
    await expectRefused(putMine(t1, 'votes', P1, { value: 1 }, 0), 409, 'version_conflict');
    // Another parent is another document.
    const other = (await expectOk(putMine(t1, 'votes', P2, { value: 1 }))).body as Doc;
    expect(other.key.startsWith(`${P2}:`)).toBe(true);
    expect((await rows(A, 'votes')).map((r) => r.key).sort()).toEqual(
      [first.key, other.key].sort()
    );
  });

  it('keyPrefix=<parent>: lists exactly one parent’s documents, author=me the viewer’s own', async () => {
    const A = freshApp();
    const [t1, t2] = [await mint(A, V1), await mint(A, V2)];
    const a = (await expectOk(putMine(t1, 'votes', P1, { value: 1 }))).body as Doc;
    const b = (await expectOk(putMine(t2, 'votes', P1, { value: 1 }))).body as Doc;
    const c = (await expectOk(putMine(t1, 'votes', P2, { value: -1 }))).body as Doc;
    const keysOf = (r: Reply) => (r.body as { items: Doc[] }).items.map((d) => d.key).sort();
    const byParent = await expectOk(
      call(await mint(A, null), 'GET', ['votes'], { query: { keyPrefix: `${P1}:` } })
    );
    expect(keysOf(byParent)).toEqual([a.key, b.key].sort());
    const minePage = await expectOk(call(t1, 'GET', ['votes'], { query: { author: 'me' } }));
    expect(keysOf(minePage)).toEqual([a.key, c.key].sort());
  });
});

describe('the parent grammar: [A-Za-z0-9._-]{1,96}, not only dots', () => {
  const at96 = `${'a1.B_-'.repeat(16)}`;
  it.each([
    ['one character', 'q'],
    ['a ULID', P1],
    ['96 characters', at96],
    ['dots beside other characters', '.a.'],
  ])('accepted: %s', async (_label, parent) => {
    const A = freshApp();
    expect(parent.length).toBeLessThanOrEqual(96);
    await expectRefused(getMine(await mint(A, V1), 'votes', parent), 404, 'not_found');
  });

  it.each([
    ['97 characters', `${at96}z`],
    ['a colon (it would break keyPrefix=<parent>:)', 'a:b'],
    ['only dots', '..'],
    ['one dot', '.'],
    ['a space', 'a b'],
    ['non-ASCII', 'é'],
    ['an @', 'a@b'],
  ])('refused invalid_parent: %s', async (_label, parent) => {
    const A = freshApp();
    await expectRefused(
      getMine(await mint(A, V1), 'votes', parent),
      400,
      'invalid_request',
      'invalid_parent'
    );
  });

  it('a parent+viewer collection needs a parent; a viewer collection refuses one', async () => {
    const A = freshApp();
    const t1 = await mint(A, V1);
    await expectRefused(getMine(t1, 'votes'), 400, 'invalid_request', 'parent_required');
    await expectRefused(getMine(t1, 'likes', P1), 400, 'invalid_request', 'parent_not_allowed');
    await expectRefused(getMine(t1, 'records'), 400, 'invalid_request', 'not_viewer_keyed');
  });
});

describe('keyedBy viewer: one document per viewer', () => {
  it('the key is the bare digest, distinct per viewer', async () => {
    const A = freshApp();
    const k1 = (
      (await expectOk(putMine(await mint(A, V1), 'likes', undefined, { on: true }))).body as Doc
    ).key;
    const k2 = (
      (await expectOk(putMine(await mint(A, V2), 'likes', undefined, { on: true }))).body as Doc
    ).key;
    expect(k1).toMatch(DIGEST);
    expect(k2).toMatch(DIGEST);
    expect(k1).not.toBe(k2);
  });
});

describe('refusals', () => {
  it('🔴 anonymous: every @me op, reads included, is 401 sign_in_required; reads by key and list stay open', async () => {
    const A = freshApp();
    const mine = (await expectOk(putMine(await mint(A, V1), 'votes', P1, { value: 1 })))
      .body as Doc;
    const anon = await mint(A, null);
    for (const r of [
      getMine(anon, 'votes', P1),
      putMine(anon, 'votes', P1, { value: 1 }),
      deleteMine(anon, 'votes', P1),
      getMine(anon, 'likes'),
      putMine(anon, 'likes', undefined, { on: true }),
    ]) {
      await expectRefused(r, 401, 'sign_in_required');
    }
    expect(((await expectOk(call(anon, 'GET', ['votes', mine.key]))).body as Doc).key).toBe(
      mine.key
    );
    await expectOk(call(anon, 'GET', ['votes']));
  });

  it('🔴 a raw-key create, put or delete on a viewer-keyed collection is 400 viewer_keyed; a plain collection is unaffected', async () => {
    const A = freshApp();
    const t1 = await mint(A, V1);
    const raw = `${P1}:${'a'.repeat(26)}`;
    await expectRefused(
      call(t1, 'POST', ['votes'], { body: { data: { value: 1 } } }),
      400,
      'invalid_request',
      'viewer_keyed'
    );
    await expectRefused(
      call(t1, 'PUT', ['votes', raw], { body: { data: { value: 1 } } }),
      400,
      'invalid_request',
      'viewer_keyed'
    );
    await expectRefused(call(t1, 'DELETE', ['votes', raw]), 400, 'invalid_request', 'viewer_keyed');
    expect(await rows(A, 'votes')).toEqual([]);
    // Control: the same put on a collection without keyedBy writes.
    await expectOk(call(t1, 'PUT', ['records', raw], { body: { data: { value: 1 } } }));
  });

  it('🔴 a declared write:"none" collection is read-only to every viewer document write (write_policy)', async () => {
    const A = freshApp();
    const t1 = await mint(A, V1);
    await expectRefused(call(t1, 'POST', ['plays'], { body: { data: {} } }), 403, 'write_policy');
    await expectRefused(
      call(t1, 'PUT', ['plays', 'item-1'], { body: { data: {} } }),
      403,
      'write_policy'
    );
    await expectRefused(call(t1, 'DELETE', ['plays', 'item-1']), 403, 'write_policy');
    expect(await rows(A, 'plays')).toEqual([]);
  });

  it('🔴 the derivation secret unset or blank: every @me op answers 503, nothing is written', async () => {
    const A = freshApp();
    const t1 = await mint(A, V1);
    for (const value of [undefined, '   ']) {
      envMock.set({ APP_STORAGE_VIEWER_KEY_SECRET: value });
      await expectRefused(getMine(t1, 'votes', P1), 503, 'service_unavailable');
      await expectRefused(putMine(t1, 'votes', P1, { value: 1 }), 503, 'service_unavailable');
      await expectRefused(
        putMine(t1, 'likes', undefined, { on: true }),
        503,
        'service_unavailable'
      );
    }
    expect(await rows(A, 'votes')).toEqual([]);
    expect(await rows(A, 'likes')).toEqual([]);
    // Positive control: the same calls succeed once it is set.
    envMock.set({ APP_STORAGE_VIEWER_KEY_SECRET: SECRET });
    await expectOk(putMine(t1, 'votes', P1, { value: 1 }));
  });
});

describe('the per-collection switch', () => {
  it('🔴 closed: @me writes are 403 write_policy, reads work, and GET / says open: false', async () => {
    h.open.set('votes', false);
    const A = freshApp();
    const t1 = await mint(A, V1);
    await expectRefused(
      putMine(t1, 'votes', P1, { value: 1 }),
      403,
      'write_policy',
      'viewer_keyed_closed'
    );
    await expectRefused(deleteMine(t1, 'votes', P1), 403, 'write_policy', 'viewer_keyed_closed');
    await expectRefused(getMine(t1, 'votes', P1), 404, 'not_found');
    expect(await rows(A, 'votes')).toEqual([]);
    // Evaluated for this app and this collection.
    expect(h.openEvaluations).toContainEqual({ entityId: A.id, context: { collection: 'votes' } });

    const info = (await expectOk(call(t1, 'GET', []))).body as {
      collections: Record<string, Record<string, unknown>>;
    };
    expect(info.collections.votes).toMatchObject({ keyedBy: 'parent+viewer', open: false });
    expect(info.collections.likes).toMatchObject({ keyedBy: 'viewer', open: true });
    expect(info.collections.records).not.toHaveProperty('keyedBy');
    expect(info.collections.records).not.toHaveProperty('open');

    // Another collection's switch is its own: likes is open.
    await expectOk(putMine(t1, 'likes', undefined, { on: true }));
    // Opened: the same write lands.
    h.open.set('votes', true);
    await expectOk(putMine(t1, 'votes', P1, { value: 1 }));
  });
});

describe('platform policies on @me writes', () => {
  it('🔴 the content scan sees the PARENT, never the derived key', async () => {
    const A = freshApp();
    const t1 = await mint(A, V1);
    await expectOk(putMine(t1, 'votes', P1, { value: 1 }));
    expect(h.keyScans).toEqual([P1]);
    // keyedBy viewer has no parent: no key is scanned at all.
    await expectOk(putMine(t1, 'likes', undefined, { on: true }));
    expect(h.keyScans).toEqual([P1]);
    // A blocked parent is refused as a blocked key would be, and nothing is written.
    const r = await expectRefused(
      putMine(t1, 'votes', 'vkblockedterm', { value: 1 }),
      422,
      'content_rejected'
    );
    expect((r.body as { details: { field: string } }).details.field).toBe('key');
    expect((await rows(A, 'votes')).map((d) => d.key.split(':')[0])).toEqual([P1]);
  });

  it('a blocked body is refused as on any shared put', async () => {
    const A = freshApp();
    await expectRefused(
      putMine(await mint(A, V1), 'votes', P1, { text: 'vkblockedterm' }),
      422,
      'content_rejected'
    );
    expect(await rows(A, 'votes')).toEqual([]);
  });
});

describe('🔴 no path writes a viewer-keyed collection at a key the client names', () => {
  it('the route: publish into it, unpublish from it, and every tally route are 400 viewer_keyed', async () => {
    const A = freshApp();
    const t1 = await mint(A, V1);
    const key = `${P1}:${'b'.repeat(26)}`;
    await expectOk(call(t1, 'PUT', ['drafts', key], { body: { data: { value: 1 } } }));
    const refusals: Promise<Reply>[] = [
      call(t1, 'POST', ['_publish', 'votes'], { body: { from: 'drafts', keys: [key] } }),
      call(t1, 'POST', ['_unpublish', 'votes'], { body: { keys: [key] } }),
      call(t1, 'PATCH', ['votes', key], { body: { $mark: 'vote' } }),
      call(t1, 'PATCH', ['votes', key], { body: { $unmark: 'vote' } }),
      call(t1, 'PATCH', ['likes', key], { body: { $inc: { plays: 1 } } }),
      call(t1, 'PUT', ['votes', key, 'marks', 'vote']),
      call(t1, 'POST', ['likes', key, 'counters', 'plays'], { body: { by: 1 } }),
    ];
    for (const r of refusals) await expectRefused(r, 400, 'invalid_request', 'viewer_keyed');
    expect(await rows(A, 'votes')).toEqual([]);
    // Control: the same publish into a collection without keyedBy lands.
    const published = await expectOk(
      call(t1, 'POST', ['_publish', 'records'], { body: { from: 'drafts', keys: [key] } })
    );
    expect((published.body as { created: string[] }).created).toEqual([key]);
  });

  it('the store, for every caller: publish, unpublish, increment, mark and unmark refuse, even with tallies declared; a report does not', async () => {
    const A = freshApp();
    const ctx = { appId: A.id, ns: 'prod', viewerUid: V1 };
    // Declared as no manifest can be any more (the parser refuses tallies beside keyedBy): the
    // store's own refusal must not depend on that.
    const keyed: DocCollection = {
      name: 'votes',
      config: {
        kind: 'docs',
        visibility: 'shared',
        write: 'own',
        counters: ['plays'],
        marks: ['vote'],
        indexes: new Map(),
        showAuthor: false,
        keyedBy: 'parent+viewer',
      },
    };
    const drafts: DocCollection = {
      name: 'drafts',
      config: {
        kind: 'docs',
        visibility: 'private',
        counters: [],
        marks: [],
        indexes: new Map(),
        showAuthor: false,
      },
    };
    const reasonOf = (p: Promise<unknown>) =>
      p.then(
        () => 'resolved',
        (e: { code?: string; details?: { reason?: string } }) => `${e.code}:${e.details?.reason}`
      );
    const key = `${P2}:${'c'.repeat(26)}`;
    expect(
      await Promise.all([
        reasonOf(h.store.publishCopies(ctx, drafts, keyed, { keys: [key], checked: new Map() })),
        reasonOf(h.store.unpublishCopies(ctx, keyed, [key])),
        reasonOf(h.store.increment(ctx, keyed, key, 'plays', 1)),
        reasonOf(h.store.mark(ctx, keyed, key, 'vote')),
        reasonOf(h.store.unmark(ctx, keyed, key, 'vote')),
      ])
    ).toEqual(Array(5).fill('invalid_request:viewer_keyed'));
    // A report stays possible on a viewer-keyed document: it passes the check and finds no document.
    expect(await reasonOf(h.store.mark(ctx, keyed, key, 'report'))).toBe('not_found:undefined');
  });
});
