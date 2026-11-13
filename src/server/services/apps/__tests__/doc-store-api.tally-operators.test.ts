// Setup-order import: installs the env mock with the test RSA keypair BEFORE the block-token
// service and the middleware read it at module load.
import '~/__tests__/setup';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import client from 'prom-client';
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
import {
  createPgliteHarness,
  createRealPgHarness,
  REAL_PG_URL,
  type Harness,
} from './doc-store.harness';

/**
 * Tallies as UPDATE OPERATORS on the document: `PATCH /:coll/:key` with `$inc`, `$mark` or
 * `$unmark`, against the deprecated per-tally routes (`POST …/counters/:name`, `PUT|DELETE
 * …/marks/:name`) they replace. End to end, on the same boundary as
 * `doc-store-api.contract.test.ts`: a REAL signed block token → the REAL `withBlockScope` → the
 * REAL page handler → the REAL resolver → the REAL document store on an embedded Postgres with
 * RLS. Replaced at the boundary only: the Postgres rows the resolver reads, Redis (an in-memory
 * map plus the Lua harness), the session hub, the App Blocks flags and the moderation SCANNER.
 *
 * The request-table half (each operator, each refusal) is in `storage-contract.v1.json`. This
 * file pins what a request table cannot: that the two routes are ONE code path (the same reply,
 * the same rows, the same budgets, the same permission matrix), concurrency, the moderators'
 * report path, the quota, imports, the registry invariant, the deprecation headers and the
 * metric.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 120_000 });

type User = {
  id: number;
  username: string;
  createdAt: Date;
  emailVerified: Date | null;
  onboarding: number;
  bannedAt: null;
  muted: boolean;
  isModerator: boolean;
  tier: string;
};

const h = vi.hoisted(() => ({
  store: undefined as unknown as DocStore,
  users: new Map<number, unknown>(),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const real = await importOriginal<typeof FliptClient>();
  return {
    ...real,
    // Shared-data moderation ENFORCED, so a key scan that runs is inline and observable.
    isFlipt: async (flag: string, entityId?: string, context?: unknown) => {
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
// The scanner is replaced (nothing is ever a hit here); `enforcedBlockingHit` stays real.
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
import {
  createDocStore,
  createDocStoreFeed,
  createDocStoreModeration,
  PUBLISHED_NS,
} from '~/server/services/apps/doc-store';
import { DEFAULT_DOC_STORE_LIMITS } from '~/server/services/apps/doc-store.types';
import { LEGACY_TALLY_HEADERS, parseTallyPatch } from '~/server/services/apps/doc-store-api';
import { docStoreDocSource } from '~/server/registry-adapter/doc-source';
import { recordStorageImportGrants } from '~/server/services/apps/storage-import-grant.service';
import {
  DOC_STORE_REPORT_RATE_LIMIT_MAX,
  DOC_STORE_TALLY_RATE_LIMIT_MAX,
} from '~/server/utils/shared-storage-rate-limit';
import storageRoute from '~/pages/api/v1/blocks/storage/[[...path]]';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPES = ['apps:storage', 'apps:storage:publish'];
const VIEWER_QUOTA = 6;
// Distinctive ids, none of which appears in any fixture value.
const UID = { v1: 830_011, v2: 830_023, v3: 830_037, newbie: 830_041 } as const;
type Viewer = keyof typeof UID;

const MANIFEST = {
  scopes: SCOPES,
  storage: {
    collections: {
      prefs: { visibility: 'private' },
      posts: { visibility: 'shared', write: 'own', marks: ['vote'], counters: ['views'] },
      plays: { visibility: 'shared', write: 'none', marks: ['vote'], counters: ['plays'] },
      // Declared by an approved manifest, refused by the store (`write: "anyone"` is not
      // supported yet): tallies on it are refused today, on either route.
      wiki: { visibility: 'shared', write: 'anyone', marks: ['vote'], counters: ['views'] },
    },
  },
};

type AppRow = { id: string; appId: string; blockId: string; status: string; manifest: unknown };
let apps: AppRow[] = [];
let seq = 0;

function freshApp(manifest: unknown = MANIFEST, label = 'tally'): AppRow {
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

function user(name: Viewer): User {
  const trusted = name !== 'newbie';
  return {
    id: UID[name],
    username: `tally_${name}`,
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
        .map((u) => u as User)
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
  return { status, body: (body ?? {}) as Record<string, unknown>, headers };
}

// ---------------------------------------------------------------------------
// One tally, on either route
// ---------------------------------------------------------------------------

type Op = 'inc' | 'mark' | 'unmark';
type Route = 'legacy' | 'v2';
const ROUTES: Route[] = ['legacy', 'v2'];
/** Each operator with a name it is declared for on `posts`. */
const OP_NAMES: [Op, string][] = [
  ['inc', 'views'],
  ['mark', 'vote'],
  ['unmark', 'vote'],
];

/** The same tally as the deprecated route sends it, or as a PATCH update operator. */
function tally(
  route: Route,
  op: Op,
  coll: string,
  key: string,
  name: string,
  by?: number
): { method: string; path: string; body?: unknown } {
  if (route === 'legacy') {
    if (op === 'inc') {
      return {
        method: 'POST',
        path: `/${coll}/${key}/counters/${name}`,
        body: by === undefined ? undefined : { by },
      };
    }
    return { method: op === 'mark' ? 'PUT' : 'DELETE', path: `/${coll}/${key}/marks/${name}` };
  }
  const body =
    op === 'inc'
      ? { $inc: { [name]: by ?? 1 } }
      : op === 'mark'
      ? { $mark: name }
      : { $unmark: name };
  return { method: 'PATCH', path: `/${coll}/${key}`, body };
}

async function send(
  app: AppRow,
  who: Viewer | 'anon',
  route: Route,
  op: Op,
  coll: string,
  key: string,
  name: string,
  opts: { by?: number; query?: Record<string, string> } = {}
): Promise<Reply> {
  const token = await mint(app, who === 'anon' ? null : UID[who]);
  return call({ token, ...tally(route, op, coll, key, name, opts.by), query: opts.query });
}

/** Everything the store holds for one document: the row, its tallies, and its marks. */
async function snapshot(app: AppRow, coll: string, key: string, db: Harness = harness) {
  const doc = await db.raw(
    `SELECT data, version, seq, author_kind, author_uid FROM appdata.doc
      WHERE app_id = $1 AND coll = $2 AND key = $3`,
    [app.id, coll, key]
  );
  const tallies = await db.raw(
    `SELECT kind, name, count::int AS count FROM appdata.doc_tally
      WHERE app_id = $1 AND coll = $2 AND key = $3 ORDER BY kind, name`,
    [app.id, coll, key]
  );
  const marks = await db.raw(
    `SELECT name, user_id FROM appdata.doc_mark
      WHERE app_id = $1 AND coll = $2 AND key = $3 ORDER BY name, user_id`,
    [app.id, coll, key]
  );
  // Without `seq`: it is the namespace's write counter, so it cannot be compared across two apps
  // (the registry test below pins it within one).
  return {
    doc: doc.map((d) => ({
      data: d.data,
      version: Number(d.version),
      author_kind: d.author_kind,
      author_uid: d.author_uid,
    })),
    tallies,
    marks,
  };
}

const usageOf = async (app: AppRow, who: Viewer) =>
  (
    (await call({ token: await mint(app, UID[who]), method: 'GET', path: '' })).body as {
      usage: { app: { docs: number }; viewer: { docs: number } };
    }
  ).usage;

async function putPost(app: AppRow, key: string, author: Viewer = 'v1') {
  const r = await call({
    token: await mint(app, UID[author]),
    method: 'PUT',
    path: `/posts/${key}`,
    body: { data: { status: 'open' } },
  });
  expect(r.status).toBe(200);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let harness: Harness;
let liveStore: DocStore;
/** The same database, with a small per-viewer document ceiling (the quota test). */
let quotaStore: DocStore;

beforeAll(async () => {
  harness = await createPgliteHarness({ rls: true });
  liveStore = createDocStore({ db: harness.db });
  quotaStore = createDocStore({
    db: harness.db,
    limits: { ...DEFAULT_DOC_STORE_LIMITS, userDocs: VIEWER_QUOTA },
  });
  h.store = liveStore;
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(() => {
  apps = [];
  h.users.clear();
  for (const name of Object.keys(UID) as Viewer[]) h.users.set(UID[name], user(name));
  installRedis();
  installDb();
  h.store = liveStore;
});

afterEach(() => {
  expect(lua.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// The PATCH body parser
// ---------------------------------------------------------------------------

describe('parseTallyPatch: one operator, translated into the route it replaces', () => {
  const at = { collection: 'posts', key: 'k' };

  it('translates each operator into the deprecated route and its own body', () => {
    expect(parseTallyPatch(at, { $inc: { views: 3 } })).toEqual({
      route: { op: 'increment', collection: 'posts', key: 'k', name: 'views' },
      body: { by: 3 },
    });
    expect(parseTallyPatch(at, { $mark: 'vote' })).toEqual({
      route: { op: 'mark', collection: 'posts', key: 'k', name: 'vote' },
      body: undefined,
    });
    expect(parseTallyPatch(at, { $unmark: 'vote' })).toEqual({
      route: { op: 'unmark', collection: 'posts', key: 'k', name: 'vote' },
      body: undefined,
    });
  });

  it.each([
    ['no body', undefined, 'empty_patch'],
    ['an empty object', {}, 'empty_patch'],
    ['an array', [{ $mark: 'vote' }], 'malformed_operator'],
    ['a string', '$mark', 'malformed_operator'],
    ['null', null, 'malformed_operator'],
    ['an unknown operator', { $set: { a: 1 } }, 'unknown_operator'],
    ['an unknown operator beside a known one', { $mark: 'vote', $push: 1 }, 'unknown_operator'],
    ['two operators', { $inc: { views: 1 }, $mark: 'vote' }, 'multiple_operators'],
    ['$mark and $unmark', { $mark: 'vote', $unmark: 'vote' }, 'multiple_operators'],
    ['an operator with a data field', { $mark: 'vote', status: 'x' }, 'malformed_operator'],
    ['a report with a reason', { $mark: 'report', reason: 'spam' }, 'malformed_operator'],
    ['data fields only', { status: 'closed' }, 'merge_patch_unsupported'],
    ['a prototype name', { toString: 1 }, 'merge_patch_unsupported'],
    ['$inc with two counters', { $inc: { views: 1, plays: 1 } }, 'malformed_operator'],
    ['$inc with no counter', { $inc: {} }, 'malformed_operator'],
    ['$inc with a number', { $inc: 1 }, 'malformed_operator'],
    ['$inc with an array', { $inc: [['views', 1]] }, 'malformed_operator'],
    ['$mark with a number', { $mark: 1 }, 'malformed_operator'],
    ['$unmark with an array', { $unmark: ['vote'] }, 'malformed_operator'],
  ])('refuses %s: invalid_request, details.reason %s', (_name, body, reason) => {
    let thrown: unknown;
    try {
      parseTallyPatch(at, body);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'invalid_request', details: { reason } });
  });
});

// ---------------------------------------------------------------------------
// Parity: the old route and the operator are one code path
// ---------------------------------------------------------------------------

describe('legacy parity: the deprecated route and the PATCH operator give the same reply and the same rows', () => {
  type Scenario = {
    op: Op;
    coll: string;
    key: string;
    name: string;
    by?: number;
    setup: (app: AppRow) => Promise<void>;
  };
  const SCENARIOS: [string, Scenario][] = [
    [
      'increment of an existing document',
      { op: 'inc', coll: 'posts', key: 'p', name: 'views', by: 4, setup: (a) => putPost(a, 'p') },
    ],
    [
      'increment that creates a counter document (write: none)',
      { op: 'inc', coll: 'plays', key: 'g', name: 'plays', by: 2, setup: async () => undefined },
    ],
    ['mark', { op: 'mark', coll: 'posts', key: 'p', name: 'vote', setup: (a) => putPost(a, 'p') }],
    [
      'unmark',
      {
        op: 'unmark',
        coll: 'posts',
        key: 'p',
        name: 'vote',
        setup: async (a) => {
          await putPost(a, 'p');
          expect((await send(a, 'v2', 'legacy', 'mark', 'posts', 'p', 'vote')).status).toBe(200);
          expect((await send(a, 'v3', 'legacy', 'mark', 'posts', 'p', 'vote')).status).toBe(200);
        },
      },
    ],
    [
      'report mark',
      { op: 'mark', coll: 'posts', key: 'p', name: 'report', setup: (a) => putPost(a, 'p') },
    ],
  ];

  it.each(SCENARIOS)('%s', async (_name, s) => {
    const results = [];
    for (const route of ROUTES) {
      const app = freshApp();
      await s.setup(app);
      const before = await snapshot(app, s.coll, s.key);
      const r = await send(app, 'v2', route, s.op, s.coll, s.key, s.name, { by: s.by });
      const after = await snapshot(app, s.coll, s.key);
      results.push({ status: r.status, body: r.body, before, after });
    }
    const [legacy, v2] = results;
    expect(legacy.status).toBe(200);
    expect(v2).toEqual(legacy);
    // And the tally did land (a parity of two no-ops would also be equal).
    expect(legacy.after).not.toEqual(legacy.before);
  });

  type Refusal = { op: Op; coll: string; name: string; by?: number; key?: string };
  const REFUSALS: [string, Refusal][] = [
    ['a non-integer by', { op: 'inc', coll: 'posts', name: 'views', by: 1.5 }],
    ['a by of 0', { op: 'inc', coll: 'posts', name: 'views', by: 0 }],
    ['a by over the cap', { op: 'inc', coll: 'posts', name: 'views', by: 101 }],
    ['an undeclared counter', { op: 'inc', coll: 'posts', name: 'likes' }],
    ['an undeclared mark', { op: 'mark', coll: 'posts', name: 'star' }],
    ['a counter on a private collection', { op: 'inc', coll: 'prefs', name: 'views' }],
    ['a mark on a private collection', { op: 'mark', coll: 'prefs', name: 'vote' }],
    ['a report withdrawal', { op: 'unmark', coll: 'posts', name: 'report' }],
    ['a mark on a missing document', { op: 'mark', coll: 'posts', name: 'vote', key: 'absent' }],
    [
      'a counter on a missing document (write: own)',
      { op: 'inc', coll: 'posts', name: 'views', key: 'absent' },
    ],
    ['an undeclared collection', { op: 'mark', coll: 'nope', name: 'vote' }],
  ];

  it.each(REFUSALS)('the same refusal for %s', async (_name, c) => {
    const replies = [];
    for (const route of ROUTES) {
      const app = freshApp();
      await putPost(app, 'p');
      const before = await snapshot(app, 'posts', 'p');
      const r = await send(app, 'v2', route, c.op, c.coll, c.key ?? 'p', c.name, { by: c.by });
      // Nothing was written.
      expect(await snapshot(app, 'posts', 'p')).toEqual(before);
      replies.push({ status: r.status, code: r.body.code, details: r.body.details });
    }
    expect(replies[0].status).toBeGreaterThanOrEqual(400);
    expect(replies[1]).toEqual(replies[0]);
  });
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe("permissions: today's allow/deny, on both routes", () => {
  type Caller = 'author' | 'other' | 'untrusted' | 'anon';
  const POLICIES = [
    ['own', 'posts', 'views'],
    ['none', 'plays', 'plays'],
    ['anyone', 'wiki', 'views'],
  ] as const;
  const CALLERS: Caller[] = ['author', 'other', 'untrusted', 'anon'];
  const OPS: Op[] = ['inc', 'mark', 'unmark'];
  const who: Record<Caller, Viewer | 'anon'> = {
    author: 'v1',
    other: 'v2',
    untrusted: 'newbie',
    anon: 'anon',
  };
  /** Today's answer, by write policy and caller, the same for each of the three tallies. */
  const EXPECTED: Record<string, Record<Caller, { status: number; code?: string }>> = {
    own: {
      author: { status: 200 },
      other: { status: 200 },
      untrusted: { status: 403, code: 'not_eligible' },
      anon: { status: 401, code: 'sign_in_required' },
    },
    none: {
      author: { status: 200 },
      other: { status: 200 },
      untrusted: { status: 403, code: 'not_eligible' },
      anon: { status: 401, code: 'sign_in_required' },
    },
    // Declared but not supported yet: the collection is refused before anything else.
    anyone: {
      author: { status: 400, code: 'invalid_request' },
      other: { status: 400, code: 'invalid_request' },
      untrusted: { status: 400, code: 'invalid_request' },
      anon: { status: 400, code: 'invalid_request' },
    },
  };
  type Cell = { policy: string; coll: string; counter: string; caller: Caller; op: Op };
  const cells: [string, Cell][] = POLICIES.flatMap(([policy, coll, counter]) =>
    CALLERS.flatMap((caller) =>
      OPS.map((op): [string, Cell] => [
        `write ${policy} × ${caller} × ${op}`,
        { policy, coll, counter, caller, op },
      ])
    )
  );

  it.each(cells)('%s', async (_name, c) => {
    for (const route of ROUTES) {
      const app = freshApp();
      // The document the tallies land on, authored by v1: a post, or a counter document v1's
      // own first increment created.
      if (c.policy === 'own') await putPost(app, 'k');
      if (c.policy === 'none') {
        expect((await send(app, 'v1', 'legacy', 'inc', 'plays', 'k', 'plays')).status).toBe(200);
      }
      const name = c.op === 'inc' ? c.counter : 'vote';
      const r = await send(app, who[c.caller], route, c.op, c.coll, 'k', name);
      const want = EXPECTED[c.policy][c.caller];
      expect({ route, status: r.status, code: r.body.code }).toEqual({
        route,
        status: want.status,
        code: want.code,
      });
    }
  });

  it('control: the matrix pins a deny and an allow in every write policy it can reach', () => {
    for (const policy of ['own', 'none']) {
      const statuses = Object.values(EXPECTED[policy]).map((e) => e.status);
      expect(statuses).toContain(200);
      expect(statuses.some((s) => s >= 400)).toBe(true);
    }
    expect(cells).toHaveLength(POLICIES.length * CALLERS.length * OPS.length);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

// Real Postgres: the embedded one is a single session, so "parallel" requests there would only
// interleave statements inside one connection. The unit CI job sets APPDATA_TEST_DATABASE_URL.
describe.runIf(!!process.env.CI)('concurrency (real Postgres)', () => {
  it('APPDATA_TEST_DATABASE_URL is set, so the cases below run', () => {
    expect(REAL_PG_URL, 'the unit job must set APPDATA_TEST_DATABASE_URL').toBeTruthy();
  });
});

describe.skipIf(!REAL_PG_URL)('concurrency', () => {
  let pg: Harness;
  let pgStore: DocStore;
  beforeAll(async () => {
    pg = await createRealPgHarness();
    pgStore = createDocStore({ db: pg.db });
  });
  afterAll(async () => {
    await pg?.close();
  });
  beforeEach(() => {
    h.store = pgStore;
  });

  it('N parallel $inc land exactly N, on an existing document and on one the first creates', async () => {
    const N = 12;
    const app = freshApp();
    await putPost(app, 'c');
    const viewers: Viewer[] = ['v1', 'v2', 'v3'];
    for (const [coll, name] of [
      ['posts', 'views'],
      ['plays', 'plays'],
    ] as const) {
      const replies = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          send(app, viewers[i % viewers.length], 'v2', 'inc', coll, 'c', name)
        )
      );
      expect(replies.map((r) => r.status)).toEqual(Array(N).fill(200));
      // Every reply is a distinct running total: no two increments read the same count.
      expect(new Set(replies.map((r) => r.body.value)).size).toBe(N);
      const snap = await snapshot(app, coll, 'c', pg);
      expect(snap.tallies).toEqual([{ kind: 'counter', name, count: N }]);
    }
    // Exactly ONE counter document was created by the racing first increments.
    expect(
      await pg.raw(
        `SELECT count(*)::int AS n FROM appdata.doc WHERE app_id = $1 AND coll = 'plays'`,
        [app.id]
      )
    ).toEqual([{ n: 1 }]);
  });

  it('a double $mark from one viewer is idempotent; the count is the number of distinct viewers', async () => {
    const app = freshApp();
    await putPost(app, 'm');
    const viewers: Viewer[] = ['v1', 'v2', 'v3'];
    const replies = await Promise.all(
      [...viewers, ...viewers].map((v) => send(app, v, 'v2', 'mark', 'posts', 'm', 'vote'))
    );
    expect(replies.map((r) => r.status)).toEqual(Array(6).fill(200));
    const again = await send(app, 'v1', 'v2', 'mark', 'posts', 'm', 'vote');
    expect(again.body).toEqual({ marked: true, count: 3 });
    const snap = await snapshot(app, 'posts', 'm', pg);
    expect(snap.tallies).toEqual([{ kind: 'mark', name: 'vote', count: 3 }]);
    expect(snap.marks.map((m) => m.user_id).sort()).toEqual([UID.v1, UID.v2, UID.v3].sort());
  });

  it("an $unmark without a mark is a no-op with today's reply", async () => {
    const app = freshApp();
    await putPost(app, 'u');
    expect((await send(app, 'v3', 'v2', 'mark', 'posts', 'u', 'vote')).status).toBe(200);
    const before = await snapshot(app, 'posts', 'u', pg);
    const v2 = await send(app, 'v2', 'v2', 'unmark', 'posts', 'u', 'vote');
    const legacy = await send(app, 'v2', 'legacy', 'unmark', 'posts', 'u', 'vote');
    expect(v2.status).toBe(200);
    expect(v2.body).toEqual({ marked: false, count: 1 });
    expect(legacy.body).toEqual(v2.body);
    expect(await snapshot(app, 'posts', 'u', pg)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

describe('the report mark', () => {
  it("$mark: report lands in the moderators' report queue, and its count is never returned", async () => {
    const app = freshApp();
    await putPost(app, 'r');
    const r = await send(app, 'v2', 'v2', 'mark', 'posts', 'r', 'report');
    expect(r).toMatchObject({ status: 200, body: { marked: true } });
    expect('count' in r.body).toBe(false);
    const mod = createDocStoreModeration({ db: harness.db });
    const queue = await mod.listReported(app.id, PUBLISHED_NS, { status: 'open', limit: 10 });
    expect(
      queue.map((q) => ({ collection: q.collection, key: q.key, reports: q.reports }))
    ).toEqual([{ collection: 'posts', key: 'r', reports: 1 }]);
  });

  it('PATCH $unmark: report is refused before any budget or trust lookup', async () => {
    const app = freshApp();
    await putPost(app, 'w');
    expect((await send(app, 'v2', 'v2', 'mark', 'posts', 'w', 'report')).status).toBe(200);
    // An untrusted viewer is refused by the trust gate on any other tally (positive control),
    // and gets the withdrawal's 400 here, not that 403.
    expect((await send(app, 'newbie', 'v2', 'mark', 'posts', 'w', 'vote')).status).toBe(403);
    const untrusted = await send(app, 'newbie', 'v2', 'unmark', 'posts', 'w', 'report');
    expect({ status: untrusted.status, code: untrusted.body.code }).toEqual({
      status: 400,
      code: 'invalid_request',
    });
    // A refused withdrawal spends no tally budget: v2 still has the whole bucket after it.
    for (let i = 0; i < 3; i++) {
      expect((await send(app, 'v2', 'v2', 'unmark', 'posts', 'w', 'report')).status).toBe(400);
    }
    let allowed = 0;
    for (let i = 0; i < DOC_STORE_TALLY_RATE_LIMIT_MAX + 5; i++) {
      const r = await send(app, 'v2', 'v2', 'mark', 'posts', 'w', 'vote');
      if (r.status === 429) break;
      allowed += 1;
    }
    // The report mark above spent one.
    expect(allowed).toBe(DOC_STORE_TALLY_RATE_LIMIT_MAX - 1);
    // The report is still there.
    const snap = await snapshot(app, 'posts', 'w');
    expect(snap.marks).toContainEqual({ name: 'report', user_id: UID.v2 });
  });

  it('the reports-per-day limit is ONE budget across both routes', async () => {
    expect(DOC_STORE_REPORT_RATE_LIMIT_MAX).toBeLessThan(DOC_STORE_TALLY_RATE_LIMIT_MAX);
    const app = freshApp();
    await putPost(app, 'r0');
    // Alternate the routes: each report spends from the same daily bucket, even a repeat of one
    // already filed (the mark itself is idempotent).
    for (let i = 0; i < DOC_STORE_REPORT_RATE_LIMIT_MAX; i++) {
      const route = i % 2 === 0 ? 'legacy' : 'v2';
      expect((await send(app, 'v3', route, 'mark', 'posts', 'r0', 'report')).status).toBe(200);
    }
    for (const route of ROUTES) {
      const r = await send(app, 'v3', route, 'mark', 'posts', 'r0', 'report');
      expect({
        route,
        status: r.status,
        bucket: (r.body.details as { bucket?: string })?.bucket,
      }).toEqual({
        route,
        status: 429,
        bucket: 'report',
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

describe('rate limits: the tally budget is charged identically on both routes', () => {
  const PATTERNS: [string, Route[]][] = [
    ['PATCH only', ['v2']],
    ['legacy only', ['legacy']],
    ['alternating', ['legacy', 'v2']],
  ];
  it.each(PATTERNS)('%s: the same number of tallies land before a 429', async (_name, pattern) => {
    const app = freshApp();
    await putPost(app, 't');
    let allowed = 0;
    let refused: Reply | undefined;
    for (let i = 0; i < DOC_STORE_TALLY_RATE_LIMIT_MAX + 5; i++) {
      const route = pattern[i % pattern.length];
      const op: Op = i % 3 === 0 ? 'inc' : i % 3 === 1 ? 'mark' : 'unmark';
      const r = await send(app, 'v2', route, op, 'posts', 't', op === 'inc' ? 'views' : 'vote');
      if (r.status === 429) {
        refused = r;
        break;
      }
      expect(r.status).toBe(200);
      allowed += 1;
    }
    expect(allowed).toBe(DOC_STORE_TALLY_RATE_LIMIT_MAX);
    expect(refused?.body).toMatchObject({ code: 'rate_limited', details: { bucket: 'tally' } });
    // Exhausted for the other route too.
    for (const route of ROUTES) {
      expect((await send(app, 'v2', route, 'inc', 'posts', 't', 'views')).status).toBe(429);
    }
  });

  it('a malformed PATCH is refused without spending the tally budget', async () => {
    const app = freshApp();
    await putPost(app, 'b');
    const token = await mint(app, UID.v2);
    for (let i = 0; i < DOC_STORE_TALLY_RATE_LIMIT_MAX + 3; i++) {
      const r = await call({
        token,
        method: 'PATCH',
        path: '/posts/b',
        body: { $inc: { views: 1 }, $mark: 'vote' },
      });
      expect(r.status).toBe(400);
    }
    expect((await send(app, 'v2', 'v2', 'inc', 'posts', 'b', 'views')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

describe('quota: a first increment that creates a counter document', () => {
  it.each(ROUTES)(
    '%s: creates the counter-authored document and counts it toward the viewer, until the ceiling',
    async (route) => {
      h.store = quotaStore;
      const app = freshApp();
      const before = await usageOf(app, 'v1');
      const r = await send(app, 'v1', route, 'inc', 'plays', 'first', 'plays', { by: 1 });
      expect(r).toMatchObject({ status: 200, body: { value: 1 } });
      const snap = await snapshot(app, 'plays', 'first');
      expect(snap.doc).toEqual([
        { data: {}, version: 1, author_kind: 'counter', author_uid: UID.v1 },
      ]);
      const after = await usageOf(app, 'v1');
      expect(after.viewer.docs).toBe(before.viewer.docs + 1);
      expect(after.app.docs).toBe(before.app.docs + 1);
      // A second increment of the same key creates nothing.
      expect((await send(app, 'v1', route, 'inc', 'plays', 'first', 'plays')).status).toBe(200);
      expect((await usageOf(app, 'v1')).viewer.docs).toBe(after.viewer.docs);
      // Fill the viewer's ceiling with private documents; the next counter document is refused.
      const token = await mint(app, UID.v1);
      for (let i = after.viewer.docs; i < VIEWER_QUOTA; i++) {
        const put = await call({ token, method: 'PUT', path: `/prefs/q${i}`, body: { data: {} } });
        expect(put.status).toBe(200);
      }
      const over = await send(app, 'v1', route, 'inc', 'plays', 'second', 'plays');
      expect({ status: over.status, code: over.body.code }).toEqual({
        status: 413,
        code: 'quota_exceeded',
      });
      expect(await snapshot(app, 'plays', 'second')).toEqual({ doc: [], tallies: [], marks: [] });
      // An existing counter document still counts: no quota is spent.
      expect((await send(app, 'v1', route, 'inc', 'plays', 'first', 'plays')).status).toBe(200);
    }
  );
});

// ---------------------------------------------------------------------------
// The registry invariant
// ---------------------------------------------------------------------------

describe('🔴 REGRESSION: a tally never changes a document body or its registry revision', () => {
  it.each(ROUTES)('%s: data, version, seq and the registry feed are unchanged', async (route) => {
    const app = freshApp();
    await putPost(app, 'reg');
    // A write:none counter document, created before the snapshot (its creation is a write).
    expect((await send(app, 'v1', 'legacy', 'inc', 'plays', 'reg', 'plays')).status).toBe(200);
    const source = docStoreDocSource(createDocStoreFeed({ db: harness.db }));
    const registry = async () => {
      const head = await source.head(app.id);
      return {
        head,
        posts: await source.documents(app.id, 'posts', '', head, 100),
        plays: await source.documents(app.id, 'plays', '', head, 100),
        witness: await source.witness(app.id, 'posts', 'reg'),
      };
    };
    const rows = async () => ({
      posts: await harness.raw(
        `SELECT data, version, seq FROM appdata.doc WHERE app_id = $1 AND key = 'reg' ORDER BY coll`,
        [app.id]
      ),
    });
    const regBefore = await registry();
    const rowsBefore = await rows();
    expect(regBefore.posts).toHaveLength(1);
    // The AUTHOR too: a write into `data` would succeed for them, so it could not hide behind
    // a not_author refusal.
    for (const who of ['v1', 'v2', 'v3'] as const) {
      expect((await send(app, who, route, 'inc', 'posts', 'reg', 'views', { by: 3 })).status).toBe(
        200
      );
      expect((await send(app, who, route, 'inc', 'plays', 'reg', 'plays')).status).toBe(200);
      expect((await send(app, who, route, 'mark', 'posts', 'reg', 'vote')).status).toBe(200);
      expect((await send(app, who, route, 'mark', 'plays', 'reg', 'vote')).status).toBe(200);
      expect((await send(app, who, route, 'mark', 'posts', 'reg', 'report')).status).toBe(200);
    }
    expect((await send(app, 'v2', route, 'unmark', 'posts', 'reg', 'vote')).status).toBe(200);
    // The tallies landed (positive control) ...
    const snap = await snapshot(app, 'posts', 'reg');
    expect(snap.tallies).toEqual([
      { kind: 'counter', name: 'views', count: 9 },
      { kind: 'mark', name: 'report', count: 3 },
      { kind: 'mark', name: 'vote', count: 2 },
    ]);
    // ... and neither the bodies, the versions, the seqs nor the registry's view moved.
    expect(await rows()).toEqual(rowsBefore);
    expect(await registry()).toEqual(regBefore);
    expect(snap.doc[0]).toMatchObject({ data: { status: 'open' }, version: 1 });
  });
});

// ---------------------------------------------------------------------------
// Deprecation headers and the metric
// ---------------------------------------------------------------------------

describe('deprecation: the old routes say so, the PATCH does not', () => {
  it.each(OP_NAMES)(
    '%s: Deprecation and Link on the legacy route, neither on PATCH, no Sunset',
    async (op, name) => {
      const app = freshApp();
      await putPost(app, 'd');
      const legacy = await send(app, 'v2', 'legacy', op, 'posts', 'd', name);
      const v2 = await send(app, 'v2', 'v2', op, 'posts', 'd', name);
      expect(legacy.status).toBe(200);
      expect(v2.status).toBe(200);
      expect(legacy.headers.deprecation).toBe('@1794182400');
      expect(legacy.headers.link).toBe(
        '<https://developer.civitai.com/apps/guide/storage>; rel="deprecation"'
      );
      expect(LEGACY_TALLY_HEADERS).toEqual({
        Deprecation: '@1794182400',
        Link: '<https://developer.civitai.com/apps/guide/storage>; rel="deprecation"',
      });
      expect(v2.headers.deprecation).toBeUndefined();
      expect(v2.headers.link).toBeUndefined();
      for (const r of [legacy, v2]) expect(r.headers.sunset).toBeUndefined();
    }
  );

  it('a wrong method on a legacy path is a 405 that carries the headers too', async () => {
    const app = freshApp();
    const token = await mint(app, UID.v1);
    for (const [method, p, allow] of [
      ['GET', '/posts/k/counters/views', 'POST'],
      ['POST', '/posts/k/marks/vote', 'PUT, DELETE'],
    ] as const) {
      const r = await call({ token, method, path: p });
      expect({ status: r.status, code: r.body.code, allow: r.headers.allow }).toEqual({
        status: 405,
        code: 'method_not_allowed',
        allow,
      });
      expect(r.headers.deprecation, `${method} ${p}`).toBe('@1794182400');
      expect(r.headers.link, `${method} ${p}`).toBe(LEGACY_TALLY_HEADERS.Link);
    }
    // A 405 on a document path is not deprecated.
    const doc = await call({ token, method: 'POST', path: '/posts/k' });
    expect(doc.status).toBe(405);
    expect(doc.headers.deprecation).toBeUndefined();
  });

  it('a refusal from a legacy route carries the headers too; other routes never do', async () => {
    const app = freshApp();
    const refused = await send(app, 'anon', 'legacy', 'mark', 'posts', 'nope', 'vote');
    expect(refused.status).toBe(401);
    expect(refused.headers.deprecation).toBe('@1794182400');
    const token = await mint(app, UID.v1);
    for (const [method, p] of [
      ['GET', '/posts/nope'],
      ['PUT', '/posts/x'],
      ['GET', ''],
    ] as const) {
      const r = await call({
        token,
        method,
        path: p,
        body: method === 'PUT' ? { data: { status: 'open' } } : undefined,
      });
      expect(r.headers.deprecation, `${method} ${p}`).toBeUndefined();
    }
  });
});

describe('civitai_app_block_doc_store_tally_ops_total{op, route}', () => {
  const METRIC = 'civitai_app_block_doc_store_tally_ops_total';
  async function count(op: string, route: string): Promise<number> {
    const metric = client.register.getSingleMetric(METRIC) as
      | { get(): Promise<{ values: { labels: Record<string, string>; value: number }[] }> }
      | undefined;
    if (!metric) return 0;
    const hit = (await metric.get()).values.find(
      (v) => v.labels.op === op && v.labels.route === route
    );
    return hit?.value ?? 0;
  }
  async function all(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const op of ['inc', 'mark', 'unmark']) {
      for (const route of ROUTES) out[`${op}|${route}`] = await count(op, route);
    }
    return out;
  }

  it.each(OP_NAMES)(
    '%s: one increment on its own (op, route) series, nothing else moves',
    async (op, name) => {
      const app = freshApp();
      await putPost(app, 'mt');
      for (const route of ROUTES) {
        const before = await all();
        expect((await send(app, 'v2', route, op, 'posts', 'mt', name)).status).toBe(200);
        const after = await all();
        expect(after).toEqual({ ...before, [`${op}|${route}`]: before[`${op}|${route}`] + 1 });
      }
    }
  );

  it('a refused PATCH body is not counted; a refused operation is', async () => {
    const app = freshApp();
    const token = await mint(app, UID.v2);
    const before = await all();
    expect(
      (await call({ token, method: 'PATCH', path: '/posts/none', body: { status: 'x' } })).status
    ).toBe(400);
    expect(await all()).toEqual(before);
    // A well-formed operator on a missing document reached the operation: counted.
    expect((await send(app, 'v2', 'v2', 'mark', 'posts', 'none', 'vote')).status).toBe(404);
    expect(await all()).toEqual({ ...before, 'mark|v2': before['mark|v2'] + 1 });
  });
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

describe('?from= imports: a tally through an import is the same on both routes', () => {
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

  /** A source app and a consumer importing its two shared collections read-write. */
  async function pair() {
    const S = freshApp(
      {
        scopes: ['apps:storage', PUBLISH],
        storage: {
          collections: {
            board: { visibility: 'shared', write: 'own', marks: ['vote'], counters: ['views'] },
            plays: { visibility: 'shared', write: 'none', counters: ['plays'] },
          },
        },
      },
      'impsrc'
    );
    const C = freshApp(
      {
        scopes: CONSUMER_SCOPES,
        storage: {
          collections: { own: { visibility: 'private' } },
          imports: [{ from: S.blockId, collections: ['board', 'plays'], access: 'readwrite' }],
        },
      },
      'impfork'
    );
    await ledger.query(`INSERT INTO "User" VALUES ($1) ON CONFLICT DO NOTHING`, [UID.v1]);
    await ledger.exec(
      `INSERT INTO "app_blocks" VALUES ('${C.id}'), ('${S.id}') ON CONFLICT DO NOTHING`
    );
    await recordStorageImportGrants({
      userId: UID.v1,
      consumerAppBlockId: C.id,
      grants: [{ sourceAppBlockId: S.id, collections: ['board', 'plays'], access: 'readwrite' }],
    });
    const made = await call({
      token: await mint(S, UID.v2, ['apps:storage', PUBLISH]),
      method: 'PUT',
      path: '/board/b1',
      body: { data: { title: 'hi' } },
    });
    expect(made.status).toBe(200);
    return { S, C };
  }

  const STEPS: [Op, string, string][] = [
    ['inc', 'board', 'views'],
    ['inc', 'plays', 'plays'],
    ['mark', 'board', 'vote'],
    ['mark', 'board', 'report'],
    ['unmark', 'board', 'vote'],
  ];

  it('without the publish consent in the source both routes refuse; with it both land the same tallies in the SOURCE', async () => {
    const outcomes: Record<Route, unknown> = { legacy: null, v2: null };
    for (const route of ROUTES) {
      const { S, C } = await pair();
      const token = await mint(C, UID.v1, CONSUMER_SCOPES);
      const from = { from: S.blockId };
      const refused = [];
      for (const [op, coll, name] of STEPS) {
        const r = await call({
          token,
          ...tally(route, op, coll, coll === 'plays' ? 'p1' : 'b1', name),
          query: from,
        });
        refused.push({ status: r.status, code: r.body.code, details: r.body.details });
      }
      expect(refused.every((r) => r.status === 403 && r.code === 'consent_required')).toBe(true);
      publishGrants.add(`${UID.v1}|${S.id}`);
      const landed = [];
      for (const [op, coll, name] of STEPS) {
        const r = await call({
          token,
          ...tally(route, op, coll, coll === 'plays' ? 'p1' : 'b1', name),
          query: from,
        });
        landed.push({ status: r.status, body: r.body });
      }
      // The legacy headers follow the route, not the import.
      const last = await call({
        token,
        ...tally(route, 'mark', 'board', 'b1', 'vote'),
        query: from,
      });
      expect(last.headers.deprecation).toBe(route === 'legacy' ? '@1794182400' : undefined);
      outcomes[route] = {
        refused: refused.map((r) => ({
          ...r,
          details: { ...(r.details as object), from: 'source' },
        })),
        landed,
        board: await snapshot(S, 'board', 'b1'),
        plays: await snapshot(S, 'plays', 'p1'),
        // Nothing in the consumer.
        consumer: await harness.raw(`SELECT 1 FROM appdata.doc WHERE app_id = $1`, [C.id]),
      };
    }
    const legacy = outcomes.legacy as { landed: { status: number }[] };
    expect(legacy.landed.map((l) => l.status)).toEqual(STEPS.map(() => 200));
    expect(outcomes.v2).toEqual(outcomes.legacy);
  });
});
