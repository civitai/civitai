// Setup-order import: installs the env mock with the test RSA keypair BEFORE the block-token
// service and the middleware read it at module load.
import '~/__tests__/setup';
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
import { createPgliteHarness, type Harness } from './doc-store.harness';

/**
 * Rollout step 5 of docs/app-storage-generic-core.md: marks, counters, their tallies,
 * `write: "none"` counter documents and server-side publish are REMOVED. End to end, on the same
 * boundary as `doc-store-api.contract.test.ts`: a REAL signed block token → the REAL
 * `withBlockScope` → the REAL page handler → the REAL resolver → the REAL document store on an
 * embedded Postgres with RLS. Replaced at the boundary only: the Postgres rows the resolver reads,
 * Redis, the session hub, the App Blocks flags, Flipt and the moderation SCANNER.
 *
 * Pinned here:
 *   (a) every document reply still carries `counters: {}`, `marks: {}` and `viewer`, because
 *       `@civitai/sdk` up to 0.30 refuses a document without them (its `toDocument`, ported below
 *       as `sdk030ToDocument` and checked against a reply that lacks them);
 *   (b) approved manifests that still DECLARE marks, counters or `write: "none"` (the shapes two
 *       approved apps hold) keep parsing and serving: their plain documents work, the
 *       declarations are inert, and `write: "none"` is read-only, never `own`;
 *   (c) every removed route answers exactly as an unknown route does, with no deprecation
 *       header, and writes nothing.
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
    isFlipt: async (flag: string, entityId?: string, context?: unknown) => {
      if (flag === 'app-blocks-shared-data-moderation') return false;
      if (flag === 'app-blocks-shared-data-moderation-enforce') return true;
      // The removed publish routes' old flag, ON: they must be unknown routes whatever it says.
      if (flag === 'app-blocks-storage-publish') return true;
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
import { createDocStore } from '~/server/services/apps/doc-store';
import {
  APP_STORAGE_ALL_FEATURES_ON,
  parseManifestStorage,
} from '~/shared/constants/block-storage.constants';
import storageRoute from '~/pages/api/v1/blocks/storage/[[...path]]';

// ---------------------------------------------------------------------------
// The SDK's document parse, ported
// ---------------------------------------------------------------------------

/**
 * A LITERAL PORT of `toDocument` (and the `toCounts` / `toAuthor` / `toDate` it calls) from
 * `@civitai/sdk` 0.30.1, `dist/doc-store/index.js`: what every app bundle built on 0.30 does with
 * each document a storage call answers. It throws "malformed" on a reply without `counters` /
 * `marks` objects of numbers, or without `viewer` (null, or `{ marks: string[] }`). Kept as the
 * SDK wrote it, so a reply that passes here passes there.
 */
function sdk030ToDocument(reply: unknown, op: string): unknown {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    v != null && typeof v === 'object' && !Array.isArray(v);
  const fail = (what: string) => new Error(`storage ${op}: ${what}`);
  const toDate = (value: unknown, field: string) => {
    const at = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
    if (Number.isNaN(at.getTime())) throw fail(`malformed \`${field}\``);
    return at;
  };
  const toAuthor = (value: unknown) => {
    if (isRecord(value)) {
      if (value.kind === 'app' || value.kind === 'counter') return { kind: value.kind };
      if (value.kind === 'user' && typeof value.isViewer === 'boolean') {
        return { kind: 'user', isViewer: value.isViewer };
      }
    }
    throw fail('malformed `author`');
  };
  const toCounts = (value: unknown, field: string) => {
    if (!isRecord(value) || Object.values(value).some((n) => typeof n !== 'number')) {
      throw fail(`malformed \`${field}\``);
    }
    return { ...value };
  };
  if (
    !isRecord(reply) ||
    typeof reply.key !== 'string' ||
    !isRecord(reply.data) ||
    typeof reply.version !== 'number'
  ) {
    throw fail('reply is not a document');
  }
  const viewer = reply.viewer;
  if (
    viewer !== null &&
    !(
      isRecord(viewer) &&
      Array.isArray(viewer.marks) &&
      viewer.marks.every((m) => typeof m === 'string')
    )
  ) {
    throw fail('malformed `viewer`');
  }
  return {
    key: reply.key,
    data: reply.data,
    version: reply.version,
    createdAt: toDate(reply.createdAt, 'createdAt'),
    updatedAt: toDate(reply.updatedAt, 'updatedAt'),
    author: toAuthor(reply.author),
    counters: toCounts(reply.counters, 'counters'),
    marks: toCounts(reply.marks, 'marks'),
    viewer: viewer === null ? null : { marks: [...(viewer as { marks: string[] }).marks] },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPES = ['apps:storage', 'apps:storage:publish'];
// Distinctive ids, none of which appears in any fixture value.
const UID = { v1: 840_013, v2: 840_029 } as const;
type Viewer = keyof typeof UID;

/** A manifest exercising every shape: a private and a shared collection declaring nothing, and
 *  a shared one that still declares marks and counters. */
const MANIFEST = {
  scopes: SCOPES,
  storage: {
    collections: {
      prefs: { visibility: 'private' },
      board: { visibility: 'shared', write: 'own' },
      posts: { visibility: 'shared', write: 'own', marks: ['vote'], counters: ['views'] },
    },
  },
};

/**
 * The declarations the two approved apps that still declare removed primitives hold
 * (docs/app-storage-generic-core.md, "Inventory"): a counter-only `write: "none"` collection
 * (`plays`, counter `plays`) and a shared collection with a `vote` mark (`picks`). Each beside a
 * plain collection, as an app's manifest has.
 */
const COUNTER_APP_MANIFEST = {
  scopes: SCOPES,
  storage: {
    collections: {
      plays: { visibility: 'shared', write: 'none', counters: ['plays'] },
      saves: { visibility: 'private' },
    },
  },
};
const MARK_APP_MANIFEST = {
  scopes: SCOPES,
  storage: {
    collections: {
      picks: { visibility: 'shared', write: 'own', marks: ['vote'] },
      prefs: { visibility: 'private' },
    },
  },
};

type AppRow = { id: string; appId: string; blockId: string; status: string; manifest: unknown };
let apps: AppRow[] = [];
let seq = 0;

function freshApp(manifest: unknown = MANIFEST, label = 'gone'): AppRow {
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
  return {
    id: UID[name],
    username: `gone_${name}`,
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

async function expectOk(p: Promise<Reply>, status = 200): Promise<Reply> {
  const r = await p;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r;
}

/** Every row any removed primitive could have written for one app, by table. */
async function tallyRows(app: AppRow) {
  const count = async (table: string) =>
    Number(
      (
        await harness.raw(`SELECT count(*)::int AS n FROM appdata.${table} WHERE app_id = $1`, [
          app.id,
        ])
      )[0].n
    );
  return {
    doc_tally: await count('doc_tally'),
    doc_mark: await count('doc_mark'),
    mark_head: await count('mark_head'),
  };
}

const NO_TALLY_ROWS = { doc_tally: 0, doc_mark: 0, mark_head: 0 };

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

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
  h.users.clear();
  for (const name of Object.keys(UID) as Viewer[]) h.users.set(UID[name], user(name));
  installRedis();
  installDb();
});

afterEach(() => {
  expect(lua.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// (a) The SDK compatibility fields
// ---------------------------------------------------------------------------

describe('(a) every document reply carries empty counters, marks and viewer (SDK 0.30 compatibility)', () => {
  it('the port of the SDK parse refuses a reply without them (instrument control)', () => {
    const doc = {
      key: 'k',
      data: {},
      version: 1,
      createdAt: '2026-11-24T00:00:00.000Z',
      updatedAt: '2026-11-24T00:00:00.000Z',
      author: { kind: 'user', isViewer: true },
    };
    expect(() => sdk030ToDocument(doc, 'get')).toThrow('malformed `viewer`');
    expect(() => sdk030ToDocument({ ...doc, viewer: null }, 'get')).toThrow('malformed `counters`');
    expect(() => sdk030ToDocument({ ...doc, viewer: null, counters: {} }, 'get')).toThrow(
      'malformed `marks`'
    );
    // Positive control: with the three fields empty it parses.
    expect(
      sdk030ToDocument({ ...doc, viewer: null, counters: {}, marks: {} }, 'get')
    ).toMatchObject({ key: 'k', counters: {}, marks: {}, viewer: null });
  });

  it('put, get, list and get-many answer counters {}, marks {} and viewer {marks: []} on every collection, a declaring one included; anonymous reads answer viewer null', async () => {
    const app = freshApp();
    const t = await mint(app, UID.v1);
    const anon = await mint(app, null);
    const written = [
      await expectOk(
        call({ token: t, method: 'PUT', path: '/prefs/p1', body: { data: { n: 1 } } })
      ),
      await expectOk(
        call({ token: t, method: 'PUT', path: '/board/b1', body: { data: { n: 2 } } })
      ),
      await expectOk(
        call({ token: t, method: 'PUT', path: '/posts/s1', body: { data: { n: 3 } } })
      ),
    ];
    const signedIn = [
      ...written,
      await expectOk(call({ token: t, method: 'GET', path: '/posts/s1' })),
      await expectOk(call({ token: t, method: 'GET', path: '/prefs/p1' })),
    ];
    for (const r of signedIn) {
      expect({ counters: r.body.counters, marks: r.body.marks, viewer: r.body.viewer }).toEqual({
        counters: {},
        marks: {},
        viewer: { marks: [] },
      });
      expect(() => sdk030ToDocument(r.body, 'get')).not.toThrow();
    }
    const list = await expectOk(call({ token: t, method: 'GET', path: '/posts' }));
    const many = await expectOk(
      call({ token: t, method: 'POST', path: '/_get/posts', body: { keys: ['s1'] } })
    );
    for (const items of [list.body.items, many.body.items] as Record<string, unknown>[][]) {
      expect(items.map((d) => [d.key, d.counters, d.marks, d.viewer])).toEqual([
        ['s1', {}, {}, { marks: [] }],
      ]);
    }
    // An anonymous reader of the shared collections: viewer null, the rest the same.
    for (const path of ['/posts/s1', '/board/b1']) {
      const r = await expectOk(call({ token: anon, method: 'GET', path }));
      expect({ counters: r.body.counters, marks: r.body.marks, viewer: r.body.viewer }).toEqual({
        counters: {},
        marks: {},
        viewer: null,
      });
      expect(() => sdk030ToDocument(r.body, 'get')).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Approved manifests that still declare the removed primitives
// ---------------------------------------------------------------------------

describe('(b) an approved manifest declaring marks, counters or write "none" keeps parsing and serving', () => {
  it('both manifests parse on the serving path (every feature on), with their declarations kept', () => {
    for (const manifest of [COUNTER_APP_MANIFEST, MARK_APP_MANIFEST]) {
      expect(parseManifestStorage(manifest, APP_STORAGE_ALL_FEATURES_ON).errors).toEqual([]);
    }
    const plays = parseManifestStorage(
      COUNTER_APP_MANIFEST,
      APP_STORAGE_ALL_FEATURES_ON
    ).collections.get('plays');
    expect([plays?.write, plays?.counters]).toEqual(['none', ['plays']]);
  });

  it('the mark app: its plain documents serve, info lists no marks, and the declared mark is not a route', async () => {
    const app = freshApp(MARK_APP_MANIFEST, 'markapp');
    const t = await mint(app, UID.v1);
    const info = await expectOk(call({ token: t, method: 'GET', path: '' }));
    const collections = info.body.collections as Record<string, Record<string, unknown>>;
    expect(collections.picks).toEqual({
      kind: 'docs',
      visibility: 'shared',
      write: 'own',
      counters: [],
      marks: [],
      indexes: {},
      showAuthor: false,
    });
    expect((info.body.limits as { rate: Record<string, unknown> }).rate).not.toHaveProperty(
      'marksAndCountersPerMinute'
    );
    const put = await expectOk(
      call({ token: t, method: 'PUT', path: '/picks/pick-1', body: { data: { choice: 'b' } } })
    );
    expect([put.body.key, put.body.data, put.body.marks]).toEqual(['pick-1', { choice: 'b' }, {}]);
    await expectOk(call({ token: t, method: 'PUT', path: '/prefs/me', body: { data: { a: 1 } } }));
    const listed = await expectOk(call({ token: t, method: 'GET', path: '/picks' }));
    expect((listed.body.items as { key: string }[]).map((d) => d.key)).toEqual(['pick-1']);
    const vote = await call({ token: t, method: 'PUT', path: '/picks/pick-1/marks/vote' });
    expect([vote.status, vote.body.code]).toEqual([404, 'not_found']);
    expect(await tallyRows(app)).toEqual(NO_TALLY_ROWS);
  });

  it('🔴 the counter app: write "none" stays read-only (never own), its private collection serves, and the counter is not a route', async () => {
    const app = freshApp(COUNTER_APP_MANIFEST, 'ctrapp');
    const t = await mint(app, UID.v1);
    const info = await expectOk(call({ token: t, method: 'GET', path: '' }));
    const plays = (info.body.collections as Record<string, Record<string, unknown>>).plays;
    expect([plays.write, plays.counters, plays.marks]).toEqual(['none', [], []]);
    for (const [method, path, body] of [
      ['PUT', '/plays/song-1', { data: { n: 1 } }],
      ['POST', '/plays', { data: { n: 1 } }],
      ['DELETE', '/plays/song-1', undefined],
    ] as const) {
      const r = await call({ token: t, method, path, body });
      expect({ method, status: r.status, code: r.body.code }).toEqual({
        method,
        status: 403,
        code: 'write_policy',
      });
    }
    const inc = await call({
      token: t,
      method: 'POST',
      path: '/plays/song-1/counters/plays',
      body: { by: 1 },
    });
    expect([inc.status, inc.body.code]).toEqual([404, 'not_found']);
    // Reads of the read-only collection answer as an empty collection does.
    expect((await expectOk(call({ token: t, method: 'GET', path: '/plays' }))).body.items).toEqual(
      []
    );
    const miss = await call({ token: t, method: 'GET', path: '/plays/song-1' });
    expect([miss.status, miss.body.code]).toEqual([404, 'not_found']);
    // Control: the app's plain collection takes writes.
    await expectOk(call({ token: t, method: 'PUT', path: '/saves/s1', body: { data: { a: 1 } } }));
    expect(
      Number(
        (
          await harness.raw(`SELECT count(*)::int AS n FROM appdata.doc WHERE app_id = $1`, [
            app.id,
          ])
        )[0].n
      )
    ).toBe(1);
    expect(await tallyRows(app)).toEqual(NO_TALLY_ROWS);
  });
});

// ---------------------------------------------------------------------------
// (c) The removed routes are unknown routes
// ---------------------------------------------------------------------------

describe('(c) every removed route answers exactly as an unknown route does', () => {
  it('the per-tally paths, the publish paths and the tally PATCH: the unknown-route answers, no deprecation header, nothing written', async () => {
    const app = freshApp();
    const t = await mint(app, UID.v1);
    await expectOk(call({ token: t, method: 'PUT', path: '/posts/k1', body: { data: { n: 1 } } }));
    await expectOk(call({ token: t, method: 'PUT', path: '/prefs/k1', body: { data: { n: 1 } } }));
    const before = await harness.raw(
      `SELECT coll, key, version, seq FROM appdata.doc WHERE app_id = $1 ORDER BY coll, key`,
      [app.id]
    );

    // The controls: a path that never existed (404), and a method the key path never had (405).
    const unknownPath = await call({ token: t, method: 'GET', path: '/posts/k1/nothing/here' });
    expect([unknownPath.status, unknownPath.body]).toEqual([
      404,
      { code: 'not_found', message: 'no such storage route', error: 'no such storage route' },
    ]);
    const unknownMethod = await call({ token: t, method: 'POST', path: '/posts/k1' });
    expect([unknownMethod.status, unknownMethod.headers.allow, unknownMethod.body.code]).toEqual([
      405,
      'GET, PUT, DELETE',
      'method_not_allowed',
    ]);

    const asUnknownPath = [
      ['POST', '/posts/k1/counters/views', { by: 1 }],
      ['PUT', '/posts/k1/marks/vote', undefined],
      ['DELETE', '/posts/k1/marks/vote', undefined],
      ['PUT', '/posts/k1/marks/report', undefined],
      ['POST', '/_publish/posts', { from: 'prefs', keys: ['k1'] }],
      ['POST', '/_unpublish/posts', { keys: ['k1'] }],
    ] as const;
    for (const [method, path, body] of asUnknownPath) {
      const r = await call({ token: t, method, path, body });
      expect({ method, path, status: r.status, body: r.body }).toEqual({
        method,
        path,
        status: unknownPath.status,
        body: unknownPath.body,
      });
      expect([r.headers.deprecation, r.headers.link, r.headers.sunset]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    }
    const asUnknownMethod = [{ $mark: 'vote' }, { $unmark: 'vote' }, { $inc: { views: 1 } }];
    for (const body of asUnknownMethod) {
      const r = await call({ token: t, method: 'PATCH', path: '/posts/k1', body });
      expect({ body, status: r.status, allow: r.headers.allow, reply: r.body }).toEqual({
        body,
        status: unknownMethod.status,
        allow: unknownMethod.headers.allow,
        reply: unknownMethod.body,
      });
      expect(r.headers.deprecation).toBeUndefined();
    }

    // Nothing was written: no tally, mark or mark-head row, and every document as it was.
    expect(await tallyRows(app)).toEqual(NO_TALLY_ROWS);
    expect(
      await harness.raw(
        `SELECT coll, key, version, seq FROM appdata.doc WHERE app_id = $1 ORDER BY coll, key`,
        [app.id]
      )
    ).toEqual(before);
    expect(before.map((d) => `${d.coll}/${d.key}`)).toEqual(['posts/k1', 'prefs/k1']);
  });

  it('a list naming a removed parameter is refused like any unknown parameter or undeclared sort', async () => {
    const app = freshApp();
    const t = await mint(app, UID.v1);
    await expectOk(call({ token: t, method: 'PUT', path: '/posts/k1', body: { data: { n: 1 } } }));
    const unknownParam = await call({
      token: t,
      method: 'GET',
      path: '/posts',
      query: { nonsense: 'me' },
    });
    expect([unknownParam.status, unknownParam.body.code]).toEqual([400, 'invalid_request']);
    for (const [name, value] of [
      ['markedBy', 'me'],
      ['mark', 'vote'],
    ] as const) {
      const r = await call({ token: t, method: 'GET', path: '/posts', query: { [name]: value } });
      expect({ name, status: r.status, body: r.body }).toEqual({
        name,
        status: 400,
        body: {
          code: 'invalid_request',
          message: `unknown query parameter ${name}`,
          error: `unknown query parameter ${name}`,
        },
      });
      expect(r.headers.deprecation).toBeUndefined();
    }
    for (const sort of ['counter:views', '-counter:views', 'mark:vote', '-mark:vote']) {
      const r = await call({ token: t, method: 'GET', path: '/posts', query: { sort } });
      expect({ sort, status: r.status, code: r.body.code }).toEqual({
        sort,
        status: 400,
        code: 'index_not_declared',
      });
      expect(r.headers.deprecation).toBeUndefined();
    }
  });
});
