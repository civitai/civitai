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
 * A shared document PUT that changes nothing is free behind `app-blocks-storage-unchanged-writes-free`:
 * no shared-write budget token, no moderation scan, nothing written. End to end, as
 * `doc-store-api.publish.test.ts` drives it: a REAL signed block token → the REAL route → the REAL
 * document store on an embedded Postgres (RLS on, the content-levels migration applied). Replaced
 * at the boundary only: the Postgres rows the resolver reads, Redis (an in-memory map plus the Lua
 * harness for the token-bucket script), the session hub, the App Blocks and Flipt flags, and the
 * moderation SCANNER (counted; its verdict logic stays real).
 *
 * The shared write budget is asserted by its Redis hash with LITERAL values: the Lua clock is fixed
 * at T = 2031-03-04T05:06:07.000Z (1930367167000 ms), one token moves the burst refill by 60 s and
 * the daily one by 288 s. Where a case says "as today", it runs the same requests in a second app
 * with the flag OFF and compares the two outcomes, so it never restates the expected refusal.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({
  store: undefined as unknown as DocStore,
  users: new Map<number, unknown>(),
  unchangedFlag: true,
  levelsFlag: false,
  /** Every entity id the unchanged-writes flag was evaluated for. */
  unchangedFlagEntities: [] as (string | undefined)[],
  /** Run once, inside the next session-user lookup (the trust gate, before the write). */
  onSessionLookup: null as null | (() => Promise<void>),
  scans: 0,
}));

const SHADOW_FLAG = 'app-blocks-shared-data-moderation';
const ENFORCE_FLAG = 'app-blocks-shared-data-moderation-enforce';
const UNCHANGED_FLAG = 'app-blocks-storage-unchanged-writes-free';
const LEVELS_FLAG = 'app-blocks-shared-doc-levels';
const VIEWER_KEYED_OPEN_FLAG = 'app-blocks-storage-viewer-keyed-open';
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const real = await importOriginal<typeof FliptClient>();
  const isFlipt = async (flag: string, entityId?: string, context?: unknown) => {
    if (flag === SHADOW_FLAG) return false;
    if (flag === ENFORCE_FLAG) return true;
    if (flag === LEVELS_FLAG) return h.levelsFlag;
    if (flag === VIEWER_KEYED_OPEN_FLAG) return true;
    if (flag === UNCHANGED_FLAG) {
      h.unchangedFlagEntities.push(entityId);
      return h.unchangedFlag;
    }
    return real.isFlipt(flag, entityId, context as never);
  };
  // The levels flag is read through `readFliptBoolean` (`doc-levels.ts` fails closed on `null`).
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
    getSessionUserById: vi.fn(async (id: number) => {
      const hook = h.onSessionLookup;
      if (hook) {
        h.onSessionLookup = null;
        await hook();
      }
      return h.users.get(id) ?? null;
    }),
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
    if (text.includes('unchanged-blocked-term')) {
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
import { OnboardingSteps } from '~/server/common/enums';
import storageRoute from '~/pages/api/v1/blocks/storage/[[...path]]';
import internalStorageRoute from '~/pages/api/internal/blocks/storage/[[...path]]';
import { envMock } from '~/__tests__/mocks/env.mock';
import { BlockRevocation } from '~/server/services/block-revocation.service';
import { ensureRegisterAppBlockRuntimeMetrics } from '~/server/metrics/app-block-runtime.metrics';
import {
  APP_DATA_SIG_HEADER,
  APP_DATA_TS_HEADER,
  appDataRegionLine,
  signAppDataRequest,
} from '~/server/services/apps/app-data-signature';
import { getApiRegionBlock } from '~/server/middleware/api-request-policy';
import { getRegion } from '~/server/utils/region-blocking';
import { DOC_STORE_PRIVATE_WRITE_RATE_LIMIT_MAX } from '~/server/utils/shared-storage-rate-limit';

void loggingMock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T = 1_930_367_167_000; // 2031-03-04T05:06:07.000Z
// Distinctive ids, none of which appears in a fixture value.
const V1 = 824_017;
const V2 = 824_024;
const ALL_UIDS = [V1, V2];
const SCOPES = ['apps:storage', 'apps:storage:publish'];

const MANIFEST = {
  scopes: SCOPES,
  storage: {
    collections: {
      drafts: { visibility: 'private' },
      clips: {
        visibility: 'shared',
        write: 'own',
        indexes: { char: 'string', score: 'number' },
      },
    },
  },
};

// The shared write budget's Redis hash after N landed (or charged) writes, from a full bucket.
const SHARED_AFTER_ONE_WRITE = {
  b: '1930367227000', // T + 60 s: one burst token out of 30
  d: '1930367455000', // T + 288 s: one daily token out of 300
  r: '1930367167000',
};
const SHARED_AFTER_TWO_WRITES = {
  b: '1930367287000', // T + 120 s
  d: '1930367743000', // T + 576 s
  r: '1930367167000',
};

type AppRow = { id: string; appId: string; blockId: string; status: string; manifest: unknown };
let apps: AppRow[] = [];
let appSeq = 0;

function freshApp(manifest: unknown = MANIFEST): AppRow {
  appSeq += 1;
  const row = {
    id: `apb_UNCH${appSeq}`,
    appId: `appblk-unch${appSeq}`,
    blockId: `unchanged-${appSeq}`,
    status: 'approved',
    manifest,
  };
  apps.push(row);
  return row;
}

function user(id: number) {
  return {
    id,
    username: `unchanged_user_${ALL_UIDS.indexOf(id)}`,
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

async function mint(app: AppRow, uid: number): Promise<string> {
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

async function call(opts: {
  token: string;
  method: string;
  path: string;
  body?: unknown;
}): Promise<Reply> {
  const segments = opts.path.split('/').filter(Boolean);
  const text = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const req = Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {
    method: opts.method,
    url: `/api/v1/blocks/storage${opts.path}`,
    query: segments.length ? { path: segments } : {},
    headers: { authorization: `Bearer ${opts.token}` },
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

const put = (token: string, key: string, data: Record<string, unknown>, ifVersion?: number) =>
  call({
    token,
    method: 'PUT',
    path: `/clips/${key}`,
    body: ifVersion === undefined ? { data } : { data, ifVersion },
  });

async function expectOk(p: Promise<Reply>, status = 200): Promise<Reply> {
  const r = await p;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r;
}

let harness: Harness;

/** The stored shared row at `key`, with what a write moves. */
async function row(app: AppRow, key: string) {
  const [r] = await harness.raw(
    `SELECT data, version::int AS version, seq::int AS seq, updated_at, rating_status, level
       FROM appdata.doc WHERE app_id = $1 AND ns = 'prod' AND coll = 'clips' AND scope_uid = 0
         AND key = $2`,
    [app.id, key]
  );
  return r;
}

async function lastSeq(app: AppRow): Promise<number> {
  const rows = await harness.raw(
    `SELECT last_seq::int AS s FROM appdata.usage_app WHERE app_id = $1 AND ns = 'prod'`,
    [app.id]
  );
  return Number(rows[0]?.s ?? 0);
}

/** The INSERT/UPDATE/DELETE statements the store issued since statement `from`. */
const writesIn = (from: number) =>
  harness.statements
    .slice(from)
    .map((st) => st.sql)
    .filter((sql) => /^\s*(?:INSERT|UPDATE|DELETE|WITH)\b/i.test(sql));

/** The stored index rows of the shared document at `key`, by name. */
async function indexRows(app: AppRow, key: string) {
  return harness.raw(
    `SELECT name, v_text, v_num, v_type FROM appdata.doc_index
       WHERE app_id = $1 AND ns = 'prod' AND coll = 'clips' AND scope_uid = 0 AND key = $2
       ORDER BY name`,
    [app.id, key]
  );
}

/** The per-viewer `write` fixed-window counter (private writes, DELETEs), or null if never spent. */
const writeBucket = (app: AppRow, uid = V1) =>
  kv.get(`${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:docs-write:${app.id}:u:${uid}`)?.value ?? null;

const sharedBudget = (app: AppRow, uid = V1) =>
  lua.hash(`${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:docs-shared-write:v1:${app.id}:${uid}`);

/** A moderator's rating of the stored version, as the rating job records it. */
async function rate(app: AppRow, key: string, level: number) {
  await harness.raw(
    `UPDATE appdata.doc d SET level = $3, rating_status = 'rated', rated_at = now(),
       rated_version = d.version
     WHERE d.app_id = $1 AND d.ns = 'prod' AND d.coll = 'clips' AND d.key = $2`,
    [app.id, key, level]
  );
}

beforeAll(async () => {
  harness = await createPgliteHarness({ rls: true, docLevels: true });
  h.store = createDocStore({ db: harness.db });
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(() => {
  apps = [];
  h.unchangedFlag = true;
  h.levelsFlag = false;
  h.unchangedFlagEntities = [];
  h.onSessionLookup = null;
  h.scans = 0;
  h.users.clear();
  h.users.set(V1, user(V1));
  h.users.set(V2, user(V2));
  installRedis();
  installDb();
});

afterEach(() => {
  expect(lua.errors).toEqual([]);
  // Every store statement ran in a transaction bound to its own app and namespace.
  expect(harness.violations).toEqual([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('flag on: a shared put that changes nothing', () => {
  it('spends no shared-write token, runs no scan, writes nothing, and answers as the write did', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    const atFirst = harness.statements.length;
    const first = await expectOk(put(t, 'k1', { char: 'A', n: 1 }));
    // Positive control for the statement check below: a write that lands issues writes.
    expect(writesIn(atFirst).length).toBeGreaterThan(0);
    expect(sharedBudget(A)).toEqual(SHARED_AFTER_ONE_WRITE);
    expect(h.scans).toBe(1);
    const before = await row(A, 'k1');
    const seqBefore = await lastSeq(A);

    const atAgain = harness.statements.length;
    const again = await expectOk(put(t, 'k1', { char: 'A', n: 1 }));
    // Not one write statement reached the store: ONE read, unlocked, answered the put.
    expect(writesIn(atAgain)).toEqual([]);
    const issued = harness.statements.slice(atAgain).map((st) => st.sql);
    expect(issued).toHaveLength(1);
    expect(issued[0]).not.toMatch(/\bFOR (?:NO KEY )?UPDATE\b|\bFOR (?:KEY )?SHARE\b/);
    // The same success shape, and the same document: no version bump.
    expect(again.body).toEqual(first.body);
    expect((again.body as { version: number }).version).toBe(1);
    expect(sharedBudget(A)).toEqual(SHARED_AFTER_ONE_WRITE);
    expect(h.scans).toBe(1);
    expect(await row(A, 'k1')).toEqual(before);
    expect(await lastSeq(A)).toBe(seqBefore);
    // Evaluated per app: the entity is the app block id, once per shared put.
    expect(h.unchangedFlagEntities).toEqual([A.id, A.id]);
  });

  it('compares content, not bytes: the same object with its keys in another order is unchanged', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(put(t, 'k1', { char: 'A', n: 1, nested: { x: 1, y: [1, 2] } }));
    await expectOk(put(t, 'k1', { nested: { y: [1, 2], x: 1 }, n: 1, char: 'A' }));
    expect(sharedBudget(A)).toEqual(SHARED_AFTER_ONE_WRITE);
    expect(h.scans).toBe(1);
    expect((await row(A, 'k1')).version).toBe(1);
  });

  it('with ifVersion naming the current version: free too', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(put(t, 'k1', { n: 1 }));
    const r = await expectOk(put(t, 'k1', { n: 1 }, 1));
    expect((r.body as { version: number }).version).toBe(1);
    expect(sharedBudget(A)).toEqual(SHARED_AFTER_ONE_WRITE);
    expect(h.scans).toBe(1);
  });

  it('keeps the content-level rating given for the stored version (levels on)', async () => {
    h.levelsFlag = true;
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(put(t, 'k1', { n: 1 }));
    await rate(A, 'k1', 1);
    await expectOk(put(t, 'k1', { n: 1 }));
    expect(await row(A, 'k1')).toMatchObject({ version: 1, rating_status: 'rated', level: 1 });
    expect(sharedBudget(A)).toEqual(SHARED_AFTER_ONE_WRITE);

    // A real change still sends it back to be rated, as every shared write does.
    await expectOk(put(t, 'k1', { n: 2 }));
    expect(await row(A, 'k1')).toMatchObject({ version: 2, rating_status: 'pending', level: null });
    expect(sharedBudget(A)).toEqual(SHARED_AFTER_TWO_WRITES);
  });
});

describe('flag on: a shared put that changes something behaves as today', () => {
  it('spends a token, scans, and writes', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(put(t, 'k1', { n: 1 }));
    const r = await expectOk(put(t, 'k1', { n: 2 }));
    expect((r.body as { version: number; data: unknown }).version).toBe(2);
    expect((r.body as { data: unknown }).data).toEqual({ n: 2 });
    expect(sharedBudget(A)).toEqual(SHARED_AFTER_TWO_WRITES);
    expect(h.scans).toBe(2);
    expect(await row(A, 'k1')).toMatchObject({ data: { n: 2 }, version: 2 });
  });

  it('a changed body is moderated: a blocked term is refused, unchanged or not', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(put(t, 'k1', { n: 1 }));
    const r = await put(t, 'k1', { n: 1, text: 'unchanged-blocked-term' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'content_rejected' });
    expect(h.scans).toBe(2);
    expect(await row(A, 'k1')).toMatchObject({ data: { n: 1 }, version: 1 });
  });

  it.each([
    ['a stale ifVersion with an identical body', 'stale'],
    ["an identical body over another author's document", 'other'],
  ] as const)('%s: refused exactly as with the flag off', async (_label, kind) => {
    const outcome = async (flag: boolean) => {
      h.unchangedFlag = flag;
      h.scans = 0;
      const A = freshApp();
      const t1 = await mint(A, V1);
      await expectOk(put(t1, 'k1', { n: 1 }));
      await expectOk(put(t1, 'k1', { n: 2 }));
      await expectOk(put(t1, 'k1', { n: 1 }));
      const r =
        kind === 'stale'
          ? await put(t1, 'k1', { n: 1 }, 1)
          : await put(await mint(A, V2), 'k1', { n: 1 });
      return {
        status: r.status,
        body: r.body,
        stored: await row(A, 'k1'),
        budgetV1: sharedBudget(A, V1),
        budgetV2: sharedBudget(A, V2) ?? null,
        scans: h.scans,
      };
    };
    const off = await outcome(false);
    const on = await outcome(true);
    // A refusal: a 4xx, never a free success.
    expect(off.status).toBeGreaterThanOrEqual(400);
    // Two apps written a moment apart: everything but the wall clock must match.
    const clockless = (r: Record<string, unknown>) => {
      const copy = { ...r };
      delete copy.updated_at;
      return copy;
    };
    expect({ ...on, stored: clockless(on.stored) }).toEqual({
      ...off,
      stored: clockless(off.stored),
    });
  });
});

describe('flag on: unchanged means the write would change NO stored row', () => {
  it('a document with number and string index values compares its index rows equal: free', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(put(t, 'k1', { char: 'A', score: 0.1 }));
    await expectOk(put(t, 'k1', { char: 'A', score: 0.1 }));
    expect(sharedBudget(A)).toEqual(SHARED_AFTER_ONE_WRITE);
    expect(h.scans).toBe(1);
  });

  it('stored index rows missing one the declaration derives (an index declared since): written, rows restored', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(put(t, 'k1', { char: 'A', score: 3 }));
    const derived = await indexRows(A, 'k1');
    expect(derived.map((r) => r.name)).toEqual(['char', 'score']);
    // The document as it would stand had `score` been declared after it was written.
    await harness.raw(
      `DELETE FROM appdata.doc_index WHERE app_id = $1 AND ns = 'prod' AND coll = 'clips'
         AND key = 'k1' AND name = 'score'`,
      [A.id]
    );
    const r = await expectOk(put(t, 'k1', { char: 'A', score: 3 }));
    expect((r.body as { version: number }).version).toBe(2);
    expect(await indexRows(A, 'k1')).toEqual(derived);
    expect(sharedBudget(A)).toEqual(SHARED_AFTER_TWO_WRITES);
    expect(h.scans).toBe(2);
  });

  it('a stored index row the declaration no longer derives (an index dropped since): written, row removed', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(put(t, 'k1', { char: 'A' }));
    const derived = await indexRows(A, 'k1');
    await harness.raw(
      `INSERT INTO appdata.doc_index (app_id, ns, coll, scope_uid, key, name, v_text, v_num, v_type)
         VALUES ($1, 'prod', 'clips', 0, 'k1', 'dropped', 'x', NULL, 'string')`,
      [A.id]
    );
    const r = await expectOk(put(t, 'k1', { char: 'A' }));
    expect((r.body as { version: number }).version).toBe(2);
    expect(await indexRows(A, 'k1')).toEqual(derived);
    expect(sharedBudget(A)).toEqual(SHARED_AFTER_TWO_WRITES);
    expect(h.scans).toBe(2);
  });

  it('a stored body the declaration now refuses (wrong type for a declared index): refused as with the flag off', async () => {
    const outcome = async (flag: boolean) => {
      h.unchangedFlag = flag;
      h.scans = 0;
      const A = freshApp();
      const t = await mint(A, V1);
      await expectOk(put(t, 'k1', { char: 'A' }));
      // Written before `char` was declared a string index: the stored body holds a number there.
      await harness.raw(
        `UPDATE appdata.doc d SET data = '{"char": 5}'::jsonb
           WHERE d.app_id = $1 AND d.ns = 'prod' AND d.coll = 'clips' AND d.key = 'k1'`,
        [A.id]
      );
      await harness.raw(
        `DELETE FROM appdata.doc_index WHERE app_id = $1 AND ns = 'prod' AND coll = 'clips'
           AND key = 'k1'`,
        [A.id]
      );
      const r = await put(t, 'k1', { char: 5 });
      return { status: r.status, body: r.body, budget: sharedBudget(A), scans: h.scans };
    };
    const off = await outcome(false);
    const on = await outcome(true);
    expect(off.status).toBe(400);
    expect(on).toEqual(off);
  });
});

describe('flag on: the free path is throttled and counted', () => {
  it('a loop of identical puts is refused 429 by the per-viewer write bucket', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(put(t, 'k1', { n: 1 }));
    let refused: Reply | null = null;
    let served = 1;
    for (let i = 0; i < 200 && !refused; i++) {
      const r = await put(t, 'k1', { n: 1 });
      if (r.status === 200) served += 1;
      else refused = r;
    }
    // One bucket's worth a minute: the first write and the free puts after it are served, the
    // next is refused.
    expect(served).toBe(DOC_STORE_PRIVATE_WRITE_RATE_LIMIT_MAX);
    expect(refused?.status).toBe(429);
    expect(refused?.body).toMatchObject({ code: 'rate_limited', details: { bucket: 'write' } });
    // None of the free puts spent the shared-write budget.
    expect(sharedBudget(A)).toEqual(SHARED_AFTER_ONE_WRITE);
  });
});

describe('a body equal to an OLDER version is a change', () => {
  it('a body equal to the OLD document, after another write changed it before the probe, spends, scans and writes', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(put(t, 'k1', { n: 1 }));
    expect(h.scans).toBe(1);
    // Between the request's arrival and its write, another write changes the document: the
    // request's body (n: 1) was "unchanged" when it was sent and is a change by the time it lands.
    h.onSessionLookup = async () => {
      await harness.raw(
        `UPDATE appdata.doc d SET data = '{"n": 2}'::jsonb, version = d.version + 1
         WHERE d.app_id = $1 AND d.ns = 'prod' AND d.coll = 'clips' AND d.key = 'k1'`,
        [A.id]
      );
    };
    const r = await expectOk(put(t, 'k1', { n: 1 }));
    expect(h.onSessionLookup).toBeNull(); // the intervening write ran
    expect((r.body as { version: number }).version).toBe(3);
    expect(await row(A, 'k1')).toMatchObject({ data: { n: 1 }, version: 3 });
    expect(sharedBudget(A)).toEqual(SHARED_AFTER_TWO_WRITES);
    expect(h.scans).toBe(2);
  });
});

describe('flag off: byte-identical to today', () => {
  it('an identical shared put spends a token, scans and bumps the version', async () => {
    h.unchangedFlag = false;
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(put(t, 'k1', { n: 1 }));
    const r = await expectOk(put(t, 'k1', { n: 1 }));
    expect((r.body as { version: number }).version).toBe(2);
    expect(sharedBudget(A)).toEqual(SHARED_AFTER_TWO_WRITES);
    expect(h.scans).toBe(2);
    expect((await row(A, 'k1')).version).toBe(2);
  });

  it("shared puts never spend the per-viewer write bucket (private writes' and DELETEs')", async () => {
    h.unchangedFlag = false;
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(put(t, 'k1', { n: 1 }));
    await expectOk(put(t, 'k1', { n: 1 }));
    await expectOk(put(t, 'k1', { n: 2 }));
    expect(writeBucket(A)).toBeNull();
    // Positive control: the bucket this reads is the one a private write spends.
    await expectOk(call({ token: t, method: 'PUT', path: '/drafts/p1', body: { data: { n: 1 } } }));
    expect(writeBucket(A)).toBe('1');
  });
});

describe('a moderator-hidden document', () => {
  it("its author's identical put is the same 404 not_found with the flag on as off", async () => {
    const outcome = async (flag: boolean) => {
      h.unchangedFlag = flag;
      h.scans = 0;
      const A = freshApp();
      const t = await mint(A, V1);
      await expectOk(put(t, 'k1', { n: 1 }));
      await harness.raw(
        `UPDATE appdata.doc d SET hidden_at = now()
           WHERE d.app_id = $1 AND d.ns = 'prod' AND d.coll = 'clips' AND d.key = 'k1'`,
        [A.id]
      );
      const r = await put(t, 'k1', { n: 1 });
      return { status: r.status, body: r.body, budget: sharedBudget(A), scans: h.scans };
    };
    const off = await outcome(false);
    const on = await outcome(true);
    expect(off.status).toBe(404);
    expect(off.body).toMatchObject({ code: 'not_found' });
    expect(on).toEqual(off);
  });
});

describe('scope: shared puts only', () => {
  it('INVARIANT GUARD: private writes and creates never evaluate the flag', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(call({ token: t, method: 'PUT', path: '/drafts/p1', body: { data: { n: 1 } } }));
    await expectOk(
      call({ token: t, method: 'POST', path: '/clips', body: { data: { n: 1 } } }),
      201
    );
    expect(h.unchangedFlagEntities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The signed internal route app-data-go forwards writes to (apps/app-data-go/WRITES-DESIGN.md,
// build step 1): the REAL page, the REAL signature front, the REAL block-token middleware and
// handler, the same store. Kept in this file because it already holds the whole world the public
// route needs, so driving both routes side by side costs no new mock.
// ---------------------------------------------------------------------------

const SIGNING_KEY = 'internal-route-test-key-5521-abcdefghij';
const VOTE_MANIFEST = {
  scopes: SCOPES,
  storage: {
    collections: {
      ...MANIFEST.storage.collections,
      clips: { ...MANIFEST.storage.collections.clips, marks: ['vote'] },
    },
  },
};

type Routed = Reply & { headers: Record<string, unknown> };

/** One request to a storage page: the public one, or the internal one, signed or not. */
async function send(opts: {
  internal: boolean;
  token: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Internal only: sign the request (default true). */
  signed?: boolean;
  /** Region headers, sent and (internal) signed. */
  region?: Record<string, string>;
  /** Headers added AFTER signing (a tampered forward). */
  unsigned?: Record<string, string>;
}): Promise<Routed> {
  const segments = opts.path.split('/').filter(Boolean);
  const text = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const qs = opts.query ? new URLSearchParams(opts.query).toString() : '';
  const prefix = opts.internal ? '/api/internal/blocks/storage' : '/api/v1/blocks/storage';
  const target = `${prefix}${opts.path}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token}`,
    ...(opts.region ?? {}),
  };
  if (opts.internal && opts.signed !== false) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers[APP_DATA_TS_HEADER] = timestamp;
    headers[APP_DATA_SIG_HEADER] = signAppDataRequest(SIGNING_KEY, {
      method: opts.method,
      path: target,
      query: qs,
      timestamp,
      body: Buffer.from(text),
      region: appDataRegionLine(opts.region ?? {}) ?? '',
    });
  }
  Object.assign(headers, opts.unsigned ?? {});
  const req = Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {
    method: opts.method,
    url: qs ? `${target}?${qs}` : target,
    query: { ...(segments.length ? { path: segments } : {}), ...(opts.query ?? {}) },
    headers,
    socket: { remoteAddress: '198.51.100.9' },
  }) as unknown as NextApiRequest;
  const resHeaders: Record<string, unknown> = {};
  let body: unknown;
  const res = {
    statusCode: 0,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
    // The region gate answers with `statusCode` + `end(body)`, as the proxy's block does.
    end(chunk?: unknown) {
      if (typeof chunk === 'string') body = JSON.parse(chunk);
      return res;
    },
    send: () => res,
    setHeader(k: string, v: unknown) {
      resHeaders[k.toLowerCase()] = v;
      return res;
    },
    getHeader: (k: string) => resHeaders[k.toLowerCase()],
    removeHeader: () => res,
    writeHead: () => res,
    on: () => res,
  };
  const route = opts.internal ? internalStorageRoute : storageRoute;
  await route(req, res as unknown as NextApiResponse);
  return { status: res.statusCode, body, headers: resHeaders };
}

/** Every document-store rate bucket the app's viewer has spent (read, write, tally, report). */
const docBuckets = (app: AppRow) =>
  [...kv.keys()].filter((k) => k.includes(':docs-') && k.includes(`:${app.id}:`)).sort();

/** A private document's row, or undefined. */
async function draftRow(app: AppRow, key: string) {
  const [r] = await harness.raw(
    `SELECT seq::int AS seq, record_id FROM appdata.doc
       WHERE app_id = $1 AND ns = 'prod' AND coll = 'drafts' AND key = $2`,
    [app.id, key]
  );
  return r as { seq: number; record_id: string } | undefined;
}

/** `app_storage_requests_total` for one app, as `op/via/viewer/token_kind -> value`. */
async function viaCounts(app: AppRow): Promise<Record<string, number>> {
  const { values } = await ensureRegisterAppBlockRuntimeMetrics().appStorageRequestsTotal.get();
  return Object.fromEntries(
    values
      .filter((v) => v.labels.app === app.id)
      .map((v) => [
        `${v.labels.op}/${v.labels.via}/${v.labels.viewer}/${v.labels.token_kind}`,
        v.value,
      ])
  );
}

describe('the signed internal route', () => {
  beforeEach(() => envMock.set({ APP_DATA_WRITES_SIGNING_KEY: SIGNING_KEY }));
  afterEach(() => envMock.set({ APP_DATA_WRITES_SIGNING_KEY: undefined }));

  it('is off while APP_DATA_WRITES_SIGNING_KEY is unset: 404 service_route_off, nothing written', async () => {
    envMock.set({ APP_DATA_WRITES_SIGNING_KEY: undefined });
    const A = freshApp();
    const t = await mint(A, V1);
    const r = await send({
      internal: true,
      token: t,
      method: 'PUT',
      path: '/drafts/absent-1',
      query: { from: A.blockId },
      body: { data: { n: 11 } },
    });
    expect(r.status).toBe(404);
    expect((r.body as { code: string }).code).toBe('service_route_off');
    expect(await draftRow(A, 'absent-1')).toBeUndefined();
  });

  it('without a valid signature never reaches the chain: 401, nothing written, nothing charged', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    const r = await send({
      internal: true,
      signed: false,
      token: t,
      method: 'PUT',
      path: '/drafts/unsigned-1',
      query: { from: A.blockId },
      body: { data: { n: 12 } },
    });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({
      code: 'service_signature',
      message: 'invalid service signature',
      error: 'invalid service signature',
    });
    expect(await draftRow(A, 'unsigned-1')).toBeUndefined();
    expect(writeBucket(A)).toBeNull();
    // Positive control: the same request, signed, lands.
    await expectOk(
      send({
        internal: true,
        token: t,
        method: 'PUT',
        path: '/drafts/unsigned-1',
        query: { from: A.blockId },
        body: { data: { n: 12 } },
      })
    );
    expect(await draftRow(A, 'unsigned-1')).toBeDefined();
  });

  it("a private put answers the row's seq and recordId; the public route answers neither", async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    const viaService = await expectOk(
      send({
        internal: true,
        token: t,
        method: 'PUT',
        path: '/drafts/seq-1',
        query: { from: A.blockId },
        body: { data: { n: 21 } },
      })
    );
    const stored = await draftRow(A, 'seq-1');
    expect(viaService.body).toMatchObject({
      key: 'seq-1',
      data: { n: 21 },
      version: 1,
      seq: stored?.seq,
      recordId: stored?.record_id,
    });
    expect(typeof (viaService.body as { recordId: unknown }).recordId).toBe('string');
    expect(await lastSeq(A)).toBe(stored?.seq);

    const direct = await expectOk(
      call({ token: t, method: 'PUT', path: '/drafts/seq-2', body: { data: { n: 22 } } })
    );
    expect(Object.keys(direct.body as object)).not.toContain('seq');
    expect(Object.keys(direct.body as object)).not.toContain('recordId');
  });

  it('a shared create answers seq, recordId and its timestamps', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    const r = await expectOk(
      send({
        internal: true,
        token: t,
        method: 'POST',
        path: '/clips',
        query: { from: A.blockId },
        body: { data: { char: 'Q', score: 31 } },
      }),
      201
    );
    const b = r.body as { key: string; seq: number; recordId: string; createdAt: string };
    expect(b.seq).toBe(await lastSeq(A));
    expect(b.seq).toBeGreaterThan(0);
    expect(typeof b.recordId).toBe('string');
    expect(Number.isNaN(Date.parse(b.createdAt))).toBe(false);
    expect((await row(A, b.key))?.seq).toBe(b.seq);
  });

  it("a delete answers its tombstone's seq and the key it removed; a delete that removed nothing answers none", async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    const put1 = await expectOk(
      send({
        internal: true,
        token: t,
        method: 'PUT',
        path: '/drafts/del-1',
        query: { from: A.blockId },
        body: { data: { n: 41 } },
      })
    );
    const del = await expectOk(
      send({
        internal: true,
        token: t,
        method: 'DELETE',
        path: '/drafts/del-1',
        query: { from: A.blockId },
      })
    );
    // The key: what the overlay hides. For an `@me` delete it is the derived key, which the
    // caller never sent, so the answer is the only place it learns it.
    expect(del.body).toEqual({ deleted: true, seq: await lastSeq(A), key: 'del-1' });
    expect((del.body as { seq: number }).seq).toBeGreaterThan((put1.body as { seq: number }).seq);
    const again = await expectOk(
      send({
        internal: true,
        token: t,
        method: 'DELETE',
        path: '/drafts/del-1',
        query: { from: A.blockId },
      })
    );
    expect(again.body).toEqual({ deleted: false });
  });

  it('🔴 an `@me` put and delete are served there, and the delete answers the DERIVED key it removed, never the raw path segment', async () => {
    envMock.set({
      APP_DATA_WRITES_SIGNING_KEY: SIGNING_KEY,
      APP_STORAGE_VIEWER_KEY_SECRET: 'unchanged-viewer-key-secret-7d31',
    });
    const PARENT = 'post-6152';
    const A = freshApp({
      scopes: SCOPES,
      storage: {
        collections: {
          ...MANIFEST.storage.collections,
          likes: { visibility: 'shared', write: 'own', keyedBy: 'parent+viewer' },
        },
      },
    });
    const t = await mint(A, V1);
    try {
      await expectOk(
        send({
          internal: true,
          token: t,
          method: 'PUT',
          path: `/likes/@me/${PARENT}`,
          query: { from: A.blockId },
          body: { data: { n: 61 } },
        })
      );
      // The key the store holds the document at: the parent, a colon, a 26-character digest.
      const stored = await harness.raw(
        `SELECT key FROM appdata.doc WHERE app_id = $1 AND ns = 'prod' AND coll = 'likes'`,
        [A.id]
      );
      expect(stored.length).toBe(1);
      const derived = (stored[0] as { key: string }).key;
      expect(derived).toMatch(/^post-6152:[a-z2-7]{26}$/);
      const del = await expectOk(
        send({
          internal: true,
          token: t,
          method: 'DELETE',
          path: `/likes/@me/${PARENT}`,
          query: { from: A.blockId },
        })
      );
      expect(del.body).toEqual({ deleted: true, seq: await lastSeq(A), key: derived });
      expect((del.body as { key: string }).key).not.toBe(PARENT);
      expect((del.body as { key: string }).key).not.toBe('@me');
      // The read of the same document is not a route there: reads stay on the streams.
      const read = await send({
        internal: true,
        token: t,
        method: 'GET',
        path: `/likes/@me/${PARENT}`,
        query: { from: A.blockId },
      });
      expect(read.status).toBe(404);
      expect((read.body as { code: string }).code).toBe('not_found');
    } finally {
      envMock.set({ APP_STORAGE_VIEWER_KEY_SECRET: undefined });
    }
  });

  it('the public route answers a delete exactly `{ deleted: true }`: no seq, no key', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(
      call({ token: t, method: 'PUT', path: '/drafts/del-pub-7', body: { data: { n: 47 } } })
    );
    const del = await expectOk(call({ token: t, method: 'DELETE', path: '/drafts/del-pub-7' }));
    expect(del.body).toEqual({ deleted: true });
  });

  it('a mark answers markSeq on the internal route only', async () => {
    const A = freshApp(VOTE_MANIFEST);
    const t = await mint(A, V1);
    const created = await expectOk(
      send({
        internal: true,
        token: t,
        method: 'POST',
        path: '/clips',
        query: { from: A.blockId },
        body: { data: { char: 'M', score: 51 } },
      }),
      201
    );
    const key = (created.body as { key: string }).key;
    const marked = await expectOk(
      send({
        internal: true,
        token: t,
        method: 'PATCH',
        path: `/clips/${key}`,
        query: { from: A.blockId },
        body: { $mark: 'vote' },
      })
    );
    expect(marked.body).toMatchObject({ marked: true, count: 1 });
    expect(typeof (marked.body as { markSeq: unknown }).markSeq).toBe('number');
    const unmarked = await expectOk(
      call({ token: t, method: 'PATCH', path: `/clips/${key}`, body: { $unmark: 'vote' } })
    );
    expect(unmarked.body).toEqual({ marked: false, count: 0 });
  });

  it('a revoked token is refused on the internal route exactly as on the public route', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await BlockRevocation.revokeInstance(`bki_${A.id}`);
    const direct = await call({
      token: t,
      method: 'PUT',
      path: '/drafts/rev-1',
      body: { data: { n: 61 } },
    });
    const viaService = await send({
      internal: true,
      token: t,
      method: 'PUT',
      path: '/drafts/rev-1',
      query: { from: A.blockId },
      body: { data: { n: 61 } },
    });
    // The refusal is the middleware's (a 403), not the signature's, on both.
    expect(direct.status).toBe(403);
    expect({ status: viaService.status, body: viaService.body }).toEqual(direct);
    expect(await draftRow(A, 'rev-1')).toBeUndefined();
  });

  it('refuses an import 501 not_supported_here before anything is charged; its own app is served', async () => {
    const A = freshApp();
    const B = freshApp();
    const t = await mint(A, V1);
    const r = await send({
      internal: true,
      token: t,
      method: 'PUT',
      path: '/drafts/imp-1',
      query: { from: B.blockId },
      body: { data: { n: 71 } },
    });
    expect(r.status).toBe(501);
    expect(r.body).toEqual({
      code: 'not_supported_here',
      message: 'imports are not served on this route',
      error: 'imports are not served on this route',
    });
    // Nothing charged: no read bucket (the import's own charge, `charge('read', own, req)` just
    // below the refusal in the handler), no write bucket, no other document-store bucket.
    expect(
      kv.get(`${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:docs-read:${A.id}:u:${V1}`)
    ).toBeUndefined();
    expect(writeBucket(A)).toBeNull();
    expect(docBuckets(A)).toEqual([]);
    expect(await draftRow(A, 'imp-1')).toBeUndefined();
    expect(await draftRow(B, 'imp-1')).toBeUndefined();
    // `from` naming the token's own app is an own call.
    await expectOk(
      send({
        internal: true,
        token: t,
        method: 'PUT',
        path: '/drafts/imp-1',
        query: { from: A.blockId },
        body: { data: { n: 71 } },
      })
    );
    expect(await draftRow(A, 'imp-1')).toBeDefined();
  });

  it('serves writes and info only: a read is no route there', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(
      call({ token: t, method: 'PUT', path: '/drafts/rd-1', body: { data: { n: 81 } } })
    );
    for (const path of ['/drafts/rd-1', '/drafts']) {
      const r = await send({
        internal: true,
        token: t,
        method: 'GET',
        path,
        query: { from: A.blockId },
      });
      expect(r.status, path).toBe(404);
      expect((r.body as { code: string }).code, path).toBe('not_found');
    }
    const info = await expectOk(
      send({ internal: true, token: t, method: 'GET', path: '', query: { from: A.blockId } })
    );
    expect(Object.keys(info.body as object).sort()).toEqual(['collections', 'limits', 'usage']);
  });

  it('applies the API region block to the signed region, exactly as the proxy does on the public route', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    // What the public route's proxy (`apiRegionBlockMiddleware`) answers a request from GB: the
    // same decision function on the same headers. Positive control: GB is blocked here.
    const expected = getApiRegionBlock(getRegion({ headers: { 'cf-ipcountry': 'GB' } } as never));
    expect(expected).not.toBeNull();
    const blocked = await send({
      internal: true,
      token: t,
      method: 'PUT',
      path: '/drafts/geo-1',
      query: { from: A.blockId },
      region: { 'cf-ipcountry': 'GB' },
      body: { data: { n: 101 } },
    });
    expect({ status: blocked.status, body: blocked.body }).toEqual({
      status: expected?.status,
      body: JSON.parse(expected?.body ?? 'null'),
    });
    expect(blocked.headers['content-type']).toBe(expected?.contentType);
    expect(await draftRow(A, 'geo-1')).toBeUndefined();
    expect(docBuckets(A)).toEqual([]);
    // The UK override header the edge sets is part of the same decision.
    const uk = await send({
      internal: true,
      token: t,
      method: 'PUT',
      path: '/drafts/geo-1',
      query: { from: A.blockId },
      region: { 'cf-ipcountry': 'FR', 'x-isuk': 'true' },
      body: { data: { n: 101 } },
    });
    expect(uk.status).toBe(expected?.status);
    // An allowed region is served.
    await expectOk(
      send({
        internal: true,
        token: t,
        method: 'PUT',
        path: '/drafts/geo-1',
        query: { from: A.blockId },
        region: { 'cf-ipcountry': 'US', 'cf-region-code': 'TX' },
        body: { data: { n: 101 } },
      })
    );
  });

  it('a region header changed after signing is a signature mismatch, not a region decision', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    const r = await send({
      internal: true,
      token: t,
      method: 'PUT',
      path: '/drafts/geo-2',
      query: { from: A.blockId },
      region: { 'cf-ipcountry': 'GB' },
      unsigned: { 'cf-ipcountry': 'US' },
      body: { data: { n: 102 } },
    });
    expect(r.status).toBe(401);
    expect((r.body as { code: string }).code).toBe('service_signature');
    expect(await draftRow(A, 'geo-2')).toBeUndefined();
  });

  it('refuses a named major that is not the current one 409 stale_major; the current one is served', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    const stale = await send({
      internal: true,
      token: t,
      method: 'PUT',
      path: '/drafts/maj-1',
      query: { from: A.blockId, major: '7' },
      body: { data: { n: 111 } },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'stale_major', details: { currentMajor: 1 } });
    expect(await draftRow(A, 'maj-1')).toBeUndefined();
    await expectOk(
      send({
        internal: true,
        token: t,
        method: 'PUT',
        path: '/drafts/maj-1',
        query: { from: A.blockId, major: '1' },
        body: { data: { n: 111 } },
      })
    );
    const bad = await send({
      internal: true,
      token: t,
      method: 'PUT',
      path: '/drafts/maj-2',
      query: { from: A.blockId, major: 'v1' },
      body: { data: { n: 112 } },
    });
    expect(bad.status).toBe(400);
    // The public route takes no major at all.
    const direct = await send({
      internal: false,
      token: t,
      method: 'PUT',
      path: '/drafts/maj-3',
      query: { major: '1' },
      body: { data: { n: 113 } },
    });
    expect(direct.status).toBe(400);
  });

  it('counts each request by via, and creates the other via at 0', async () => {
    const A = freshApp();
    const t = await mint(A, V1);
    await expectOk(
      send({
        internal: true,
        token: t,
        method: 'PUT',
        path: '/drafts/via-1',
        query: { from: A.blockId },
        body: { data: { n: 91 } },
      })
    );
    expect(await viaCounts(A)).toEqual({
      'put/service/signed_in/app': 1,
      'put/direct/signed_in/app': 0,
    });
    await expectOk(
      call({ token: t, method: 'PUT', path: '/drafts/via-2', body: { data: { n: 92 } } })
    );
    await expectOk(call({ token: t, method: 'GET', path: '/drafts/via-2' }));
    expect(await viaCounts(A)).toEqual({
      'put/service/signed_in/app': 1,
      'put/direct/signed_in/app': 1,
      'get/direct/signed_in/app': 1,
      'get/service/signed_in/app': 0,
    });
  });
});
