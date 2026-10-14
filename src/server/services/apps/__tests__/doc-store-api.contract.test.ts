// Setup-order import: installs the env mock with the test RSA keypair BEFORE the block-token
// service and the middleware read it at module load.
import '~/__tests__/setup';
import { readFileSync } from 'fs';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as SessionClientModule from '~/server/auth/session-client';
import type * as Moderation from '~/server/services/apps/shared-data-moderation';
import type { SharedTextScan } from '~/server/services/apps/shared-data-moderation';
import type { DocStore } from '~/server/services/apps/doc-store';
import { createLuaRedis, type LuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import { createPgliteHarness, type Harness } from './doc-store.harness';

/**
 * The document-store REST routes, end to end: a REAL signed block token → the REAL
 * `withBlockScope` (signature, revocation, consent strip, approval, scope) → the REAL page
 * handler → the REAL resolver → the REAL document store on an embedded Postgres running the
 * real migration as the least-privilege role, with RLS on. Replaced at the boundary only:
 * the Postgres rows the resolver reads (app, publish request, users), Redis (an in-memory
 * map, plus the Lua harness for the write-budget script), the session hub, the App Blocks
 * flags, and the moderation SCANNER (whose verdict logic stays real).
 *
 * The declarative half is `public/schemas/app-block/storage-contract.v1.json`, run case by
 * case below; the rest of this file covers what a request table cannot express.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

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
  runEnabled: true,
}));

vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksRuntimeEnabled: vi.fn(async () => true),
  isAppBlocksEnabled: vi.fn(async () => h.runEnabled),
  isAppBlocksAuthorEnabled: vi.fn(async () => true),
}));
vi.mock('~/server/auth/session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionClientModule>()),
  sessionClient: { getSessionUserById: vi.fn(async (id: number) => h.users.get(id) ?? null) },
}));
vi.mock('~/server/services/apps/doc-store.instance', () => ({ getDocStore: () => h.store }));
// The scanner is replaced; `enforcedBlockingHit` (which hit refuses) stays real.
vi.mock('~/server/services/apps/shared-data-moderation', async (importOriginal) => {
  const real = await importOriginal<typeof Moderation>();
  const verdict = (text: string): SharedTextScan => {
    if (text.includes('contract-scanner-down')) throw new Error('scanner outage');
    const hit = (category: 'audit_regex' | 'link') => ({
      leafCount: 1,
      overflow: null,
      hits: [{ category, matched: 'm', label: 'l', leaf: null }],
    });
    if (text.includes('https://contract-blocked.example')) return hit('link');
    if (text.includes('contract-blocked-term')) return hit('audit_regex');
    return { leafCount: 1, overflow: null, hits: [] };
  };
  return {
    ...real,
    scanSharedData: vi.fn(async (data: unknown) => verdict(JSON.stringify(data))),
    scanCounterKey: vi.fn(async (key: string) => verdict(key)),
    recordSharedDataScan: vi.fn(async () => undefined),
  };
});

import { BlockTokenService } from '~/server/services/block-token.service';
import { REDIS_KEYS } from '~/server/redis/client';
import { createDocStore } from '~/server/services/apps/doc-store';
import { DEFAULT_DOC_STORE_LIMITS } from '~/server/services/apps/doc-store.types';
import { OnboardingSteps } from '~/server/common/enums';
import { matchStorageRoute, STORAGE_RESERVED_SEGMENTS } from '~/server/services/apps/doc-store-api';
import {
  APP_STORAGE_COLLECTION_NAME_RE,
  parseManifestStorage,
} from '~/shared/constants/block-storage.constants';
import { DOC_STORE_BOUNDS } from '~/server/services/apps/doc-store.types';
import storageRoute from '~/pages/api/v1/blocks/storage/[[...path]]';

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

type Step = {
  as: string;
  token?: 'dev';
  scopes?: string[];
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  repeat?: number;
  expect: { status: number; code?: string; body?: unknown };
};
type Case = {
  name: string;
  consentMarker?: 'unavailable' | string[];
  appStatus?: string;
  storage?: 'disabled';
  steps: Step[];
};
type Contract = {
  storage: { collections: Record<string, unknown> };
  apps: string[];
  viewers: Record<string, { username: string; trusted: boolean }>;
  limits: { viewerDocs: number };
  defaultScopes: string[];
  cases: Case[];
};

const CONTRACT_PATH = path.resolve(
  __dirname,
  '../../../../../public/schemas/app-block/storage-contract.v1.json'
);
const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as Contract;

// User ids are distinctive so the "no numeric user id in any response" check cannot pass
// by coincidence, and none of them appears in any fixture value.
const UID_BASE = 730_041;
const VIEWER_IDS = Object.fromEntries(
  Object.keys(contract.viewers).map((name, i) => [name, UID_BASE + i * 7])
) as Record<string, number>;
const ALL_UIDS = new Set(Object.values(VIEWER_IDS));

const MANIFEST = { scopes: contract.defaultScopes, storage: contract.storage };

// ---------------------------------------------------------------------------
// Fixtures: apps, users, Redis
// ---------------------------------------------------------------------------

type AppRow = {
  id: string;
  appId: string;
  blockId: string;
  status: string;
  manifest: unknown;
};
let apps: AppRow[] = [];
let publishRequests: { id: string; status: string; manifest: unknown }[] = [];
let caseSeq = 0;

function freshApps(status = 'approved', manifest: unknown = MANIFEST): Record<string, AppRow> {
  caseSeq += 1;
  const out: Record<string, AppRow> = {};
  for (const label of contract.apps) {
    const row = {
      id: `apb_${label}${caseSeq}`,
      appId: `appblk-${label.toLowerCase()}${caseSeq}`,
      blockId: `contract-${label.toLowerCase()}${caseSeq}`,
      status,
      manifest,
    };
    apps.push(row);
    out[label] = row;
  }
  return out;
}

function user(name: string, trusted: boolean): User {
  return {
    id: VIEWER_IDS[name],
    username: contract.viewers[name]?.username ?? name,
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
let failingGet: ((key: string) => boolean) | null = null;
let lua: LuaRedis;

function installRedis() {
  kv.clear();
  failingGet = null;
  lua = createLuaRedis(Date.parse('2031-03-04T05:06:07.000Z'));
  const get = async (key: string) => {
    if (failingGet?.(key)) throw new Error('redis unavailable');
    return kv.get(key)?.value ?? null;
  };
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
      where: { id?: string; appId_blockId?: { appId: string; blockId: string } };
    }) => {
      const pair = where.appId_blockId;
      return (
        apps.find((a) =>
          pair ? a.appId === pair.appId && a.blockId === pair.blockId : a.id === where.id
        ) ?? null
      );
    }
  );
  dbMock.dbWrite.appBlockPublishRequest.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      publishRequests.find((p) => p.id === where.id) ?? null
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

// ---------------------------------------------------------------------------
// Driving the route
// ---------------------------------------------------------------------------

type Reply = { status: number; body: unknown; headers: Record<string, unknown> };

async function mint(opts: {
  app: AppRow | { id: string; appId: string; blockId: string };
  uid: number | null;
  scopes: string[];
  dev?: boolean;
  reviewRunForReal?: boolean;
}): Promise<string> {
  const { token } = await BlockTokenService.sign({
    userId: opts.uid,
    blockId: opts.app.blockId,
    appId: opts.app.appId,
    appBlockId: opts.app.id,
    blockInstanceId: `bki_${opts.app.id}`,
    scopes: opts.scopes,
    ctx: {},
    maxBrowsingLevel: 1,
    domain: 'green',
    ...(opts.dev ? { dev: true } : {}),
    ...(opts.reviewRunForReal ? { reviewRunForReal: true } : {}),
  });
  return token;
}

async function call(opts: {
  token: string | null;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  ip?: string;
  origin?: string;
}): Promise<Reply> {
  const segments = opts.path.split('/').filter(Boolean);
  const req = {
    method: opts.method,
    url: `/api/v1/blocks/storage${opts.path}`,
    query: { ...(opts.query ?? {}), ...(segments.length ? { path: segments } : {}) },
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
    body: opts.body,
    socket: { remoteAddress: opts.ip ?? '198.51.100.7' },
  } as unknown as NextApiRequest;
  const headers: Record<string, unknown> = {};
  let status = 0;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
    end() {
      return res;
    },
    send() {
      return res;
    },
    setHeader(k: string, v: unknown) {
      headers[k.toLowerCase()] = v;
      return res;
    },
    getHeader(k: string) {
      return headers[k.toLowerCase()];
    },
    removeHeader() {
      return res;
    },
    writeHead() {
      return res;
    },
    on() {
      return res;
    },
  };
  await storageRoute(req, res as unknown as NextApiResponse);
  return { status, body, headers };
}

/** Every response is checked for a numeric user id, under any key or value. */
function assertNoUserId(body: unknown, where: string) {
  const walk = (v: unknown, at: string) => {
    if (typeof v === 'number') {
      expect(ALL_UIDS.has(v), `${where}: user id at ${at}`).toBe(false);
    } else if (typeof v === 'string') {
      for (const uid of ALL_UIDS)
        expect(v.includes(String(uid)), `${where}: user id in ${at}`).toBe(false);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${at}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        expect(['uid', 'userId', 'authorUserId', 'author_uid'], `${where}: key ${k}`).not.toContain(
          k
        );
        walk(x, `${at}.${k}`);
      }
    }
  };
  walk(body, '$');
}

// ---------------------------------------------------------------------------
// The contract matcher
// ---------------------------------------------------------------------------

type Vars = Record<string, unknown>;

function interpolate(s: string, vars: Vars): string {
  return s.replace(/\$\{([a-z]+)\}/g, (_, name: string) => String(vars[name]));
}

/** Request bodies: `${var}` and `$repeat:<s>:<n>` are expanded. */
function materialise(v: unknown, vars: Vars): unknown {
  if (typeof v === 'string') {
    const rep = /^\$repeat:(.):([0-9]+)$/.exec(v);
    return rep ? rep[1].repeat(Number(rep[2])) : interpolate(v, vars);
  }
  if (Array.isArray(v)) return v.map((x) => materialise(x, vars));
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [interpolate(k, vars), materialise(x, vars)])
    );
  }
  return v;
}

function matches(actual: unknown, expected: unknown, at: string, vars: Vars, errors: string[]) {
  const fail = (why: string) => errors.push(`${at}: ${why} (got ${JSON.stringify(actual)})`);
  if (typeof expected === 'string') {
    switch (expected) {
      case '$string':
        if (typeof actual !== 'string') fail('expected a string');
        return;
      case '$number':
        if (typeof actual !== 'number') fail('expected a number');
        return;
      case '$iso':
        if (
          typeof actual !== 'string' ||
          !/^\d{4}-\d\d-\d\dT/.test(actual) ||
          Number.isNaN(Date.parse(actual))
        )
          fail('expected an ISO timestamp');
        return;
      case '$present':
        if (actual === undefined) fail('expected present');
        return;
      case '$absent':
        if (actual !== undefined) fail('expected absent');
        return;
      case '$null':
        if (actual !== null) fail('expected null');
        return;
      default:
        if (actual !== interpolate(expected, vars)) fail(`expected ${interpolate(expected, vars)}`);
        return;
    }
  }
  if (expected && typeof expected === 'object' && '$capture' in expected) {
    if (actual === undefined || actual === null) fail('expected a value to capture');
    vars[(expected as { $capture: string }).$capture] = actual;
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return fail(`expected an array of ${expected.length}`);
    }
    expected.forEach((e, i) => matches(actual[i], e, `${at}[${i}]`, vars, errors));
    return;
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual))
      return fail('expected an object');
    for (const [k, e] of Object.entries(expected)) {
      matches((actual as Record<string, unknown>)[k], e, `${at}.${k}`, vars, errors);
    }
    return;
  }
  if (actual !== expected) fail(`expected ${JSON.stringify(expected)}`);
}

async function runCase(c: Case) {
  const appRows = freshApps(c.appStatus ?? 'approved');
  h.store = c.storage === 'disabled' ? createDocStore({ db: null }) : liveStore;
  const vars: Vars = {};
  if (c.consentMarker === 'unavailable') {
    failingGet = (key) => key.startsWith(REDIS_KEYS.BLOCKS.CONSENT_REVOKED_SCOPES);
  } else if (c.consentMarker) {
    for (const app of Object.values(appRows)) {
      for (const uid of ALL_UIDS) {
        kv.set(`${REDIS_KEYS.BLOCKS.CONSENT_REVOKED_SCOPES}:${uid}:${app.id}`, {
          value: JSON.stringify(c.consentMarker),
          ttl: -1,
        });
      }
    }
  }
  for (const [n, step] of c.steps.entries()) {
    for (let i = 0; i < (step.repeat ?? 1); i++) {
      vars.i = i;
      let token: string | null = null;
      if (step.as !== 'none') {
        const [who, appLabel] = step.as.split('@');
        token = await mint({
          app: appRows[appLabel],
          uid: who === 'anon' ? null : VIEWER_IDS[who],
          scopes: step.scopes ?? contract.defaultScopes,
          dev: step.token === 'dev',
        });
      }
      const reply = await call({
        token,
        method: step.method,
        path: interpolate(step.path, vars),
        query: step.query
          ? Object.fromEntries(
              Object.entries(step.query).map(([k, v]) => [k, interpolate(v, vars)])
            )
          : undefined,
        body: materialise(step.body, vars),
      });
      const where = `${c.name} — step ${n + 1}${step.repeat ? ` #${i + 1}` : ''} ${step.method} ${
        step.path
      }`;
      const errors: string[] = [];
      if (reply.status !== step.expect.status) {
        errors.push(
          `status ${reply.status} !== ${step.expect.status}: ${JSON.stringify(reply.body)}`
        );
      }
      if (step.expect.code !== undefined) {
        matches((reply.body as { code?: unknown })?.code, step.expect.code, '$.code', vars, errors);
      }
      if (step.expect.body !== undefined) matches(reply.body, step.expect.body, '$', vars, errors);
      expect(errors, where).toEqual([]);
      assertNoUserId(reply.body, where);
      // The house envelope on every refusal the storage handler itself emits.
      if (
        reply.status >= 400 &&
        step.expect.code !== undefined &&
        !MIDDLEWARE_CODES.has(step.expect.code)
      ) {
        const b = reply.body as Record<string, unknown>;
        expect(typeof b.message, where).toBe('string');
        expect(b.error, where).toBe(b.message);
      }
    }
  }
}

/** Codes the token middleware answers before the handler, in its own `{ error, code }` shape. */
const MIDDLEWARE_CODES = new Set(['insufficient_scope', 'app_not_approved']);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let harness: Harness;
let liveStore: DocStore;

beforeAll(async () => {
  harness = await createPgliteHarness({ rls: true });
  liveStore = createDocStore({
    db: harness.db,
    limits: { ...DEFAULT_DOC_STORE_LIMITS, userDocs: contract.limits.viewerDocs },
  });
  h.store = liveStore;
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(() => {
  apps = [];
  publishRequests = [];
  h.runEnabled = true;
  h.users.clear();
  for (const [name, v] of Object.entries(contract.viewers))
    h.users.set(VIEWER_IDS[name], user(name, v.trusted));
  installRedis();
  installDb();
  h.store = liveStore;
});

afterEach(() => {
  expect(lua.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('the contract file', () => {
  it('declares a storage block the manifest parser accepts in full', () => {
    const parsed = parseManifestStorage(MANIFEST);
    expect(parsed.errors).toEqual([]);
    expect([...parsed.collections.keys()].sort()).toEqual(
      Object.keys(contract.storage.collections).sort()
    );
  });

  it('every error code the storage handler can emit in phase 1 appears in some case', () => {
    const used = new Set(
      contract.cases.flatMap((c) => c.steps.map((s) => s.expect.code)).filter(Boolean)
    );
    const reachable = [
      'invalid_request',
      'index_not_declared',
      'unauthenticated',
      'sign_in_required',
      'consent_required',
      'consent_unavailable',
      'not_eligible',
      'not_author',
      'write_policy',
      'not_found',
      'collection_not_declared',
      'version_conflict',
      'too_large',
      'quota_exceeded',
      'content_rejected',
      'rate_limited',
      'storage_disabled',
      'moderation_unavailable',
    ];
    expect(reachable.filter((code) => !used.has(code))).toEqual([]);
  });
});

describe('contract cases against the real handlers', () => {
  it.each(contract.cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    await runCase(c);
  });
});

describe('reserved path segments cannot collide with a collection name or a document key', () => {
  const COLLECTIONS = ['a', 'counters', 'marks', 'get', 'x_get', 'z9'];
  const KEYS = ['_get', 'counters', 'marks', 'k', '.', '..', '_', ':x', 'A-b.c', 'x'.repeat(128)];

  it('every reserved segment is unparseable at the position(s) where a collection or key sits, or is a valid value there', () => {
    for (const { segment, position } of STORAGE_RESERVED_SEGMENTS) {
      if (position === 0) {
        // At the collection position: a leading `_` is outside the collection alphabet.
        expect(APP_STORAGE_COLLECTION_NAME_RE.test(segment), segment).toBe(false);
      } else {
        // After a key: no collection or key is ever parsed at this position.
        expect(position, segment).toBe(2);
      }
    }
  });

  it('for every valid collection name and key, the parser yields exactly that collection and key', () => {
    for (const c of COLLECTIONS) expect(APP_STORAGE_COLLECTION_NAME_RE.test(c), c).toBe(true);
    for (const k of KEYS) expect(DOC_STORE_BOUNDS.key.test(k), k).toBe(true);
    for (const c of COLLECTIONS) {
      expect(matchStorageRoute('GET', [c])).toEqual({ route: { op: 'list', collection: c } });
      expect(matchStorageRoute('POST', ['_get', c])).toEqual({
        route: { op: 'getMany', collection: c },
      });
      for (const k of KEYS) {
        for (const m of ['GET', 'PUT', 'DELETE'] as const) {
          const op = m === 'GET' ? 'get' : m === 'PUT' ? 'put' : 'delete';
          expect(matchStorageRoute(m, [c, k])).toEqual({ route: { op, collection: c, key: k } });
        }
        for (const name of ['counters', 'marks', 'vote']) {
          expect(matchStorageRoute('POST', [c, k, 'counters', name])).toEqual({
            route: { op: 'increment', collection: c, key: k, name },
          });
          expect(matchStorageRoute('PUT', [c, k, 'marks', name])).toEqual({
            route: { op: 'mark', collection: c, key: k, name },
          });
        }
      }
    }
  });

  it('live: documents keyed with every reserved word, in collections NAMED like them, are addressable', async () => {
    const decl = { visibility: 'shared', write: 'own', marks: ['vote'], counters: ['views'] };
    const { A } = freshApps('approved', {
      scopes: contract.defaultScopes,
      storage: { collections: { counters: decl, marks: decl, prefs: { visibility: 'private' } } },
    });
    const token = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    for (const coll of ['counters', 'marks']) {
      for (const key of ['_get', 'counters', 'marks']) {
        const put = await call({
          token,
          method: 'PUT',
          path: `/${coll}/${key}`,
          body: { data: { at: `${coll}/${key}` } },
        });
        expect(put.status, `${coll}/${key}`).toBe(200);
        const get = await call({ token, method: 'GET', path: `/${coll}/${key}` });
        expect(get.body).toMatchObject({ key, data: { at: `${coll}/${key}` } });
        const mark = await call({ token, method: 'PUT', path: `/${coll}/${key}/marks/vote` });
        expect(mark.body).toEqual({ marked: true, count: 1 });
        const inc = await call({ token, method: 'POST', path: `/${coll}/${key}/counters/views` });
        expect(inc.body).toEqual({ value: 1 });
      }
      const many = await call({
        token,
        method: 'POST',
        path: `/_get/${coll}`,
        body: { keys: ['_get', 'marks'] },
      });
      expect((many.body as { items: { key: string }[] }).items.map((d) => d.key)).toEqual([
        '_get',
        'marks',
      ]);
    }
  });
});

describe('namespaces per token kind', () => {
  it('a review run-for-real token reads and writes rev:<publishRequestId>, not prod or dev', async () => {
    const { A } = freshApps();
    const pubreq = {
      id: 'pubreq_01JREVIEWNAMESPACE00000000',
      status: 'pending',
      manifest: MANIFEST,
    };
    publishRequests.push(pubreq);
    const reviewApp = { id: pubreq.id, appId: 'appblk-review', blockId: 'review-slug' };
    const review = await mint({
      app: reviewApp,
      uid: VIEWER_IDS.v1,
      scopes: contract.defaultScopes,
      dev: true,
      reviewRunForReal: true,
    });
    const prod = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });

    expect(
      (
        await call({
          token: review,
          method: 'PUT',
          path: '/prefs/k',
          body: { data: { ns: 'rev' } },
        })
      ).status
    ).toBe(200);
    expect((await call({ token: prod, method: 'GET', path: '/prefs/k' })).status).toBe(404);
    const rows = await harness.raw(
      `SELECT app_id, ns FROM appdata.doc WHERE key = 'k' AND ns LIKE 'rev:%'`
    );
    expect(rows).toEqual([{ app_id: pubreq.id, ns: `rev:${pubreq.id}` }]);

    pubreq.status = 'approved';
    const after = await call({ token: review, method: 'GET', path: '/prefs/k' });
    expect(after.status).toBe(403);
    expect(after.body).toMatchObject({
      code: 'not_eligible',
      details: { reason: 'review_inactive' },
    });
  });

  it('a dev token writes dev:<uid> under the approved app id', async () => {
    const { A } = freshApps();
    const dev = await mint({
      app: A,
      uid: VIEWER_IDS.v2,
      scopes: contract.defaultScopes,
      dev: true,
    });
    expect(
      (await call({ token: dev, method: 'PUT', path: '/prefs/devkey', body: { data: {} } })).status
    ).toBe(200);
    const rows = await harness.raw(`SELECT app_id, ns FROM appdata.doc WHERE key = 'devkey'`);
    expect(rows).toEqual([{ app_id: A.id, ns: `dev:${VIEWER_IDS.v2}` }]);
  });

  it('an anonymous dev token has no namespace: sign_in_required', async () => {
    const { A } = freshApps();
    const dev = await mint({ app: A, uid: null, scopes: ['apps:storage'], dev: true });
    const r = await call({ token: dev, method: 'GET', path: '/posts' });
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ code: 'sign_in_required' });
  });

  it('the run gate on the token subject refuses with not_eligible apps_disabled', async () => {
    const { A } = freshApps();
    h.runEnabled = false;
    const t = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    const r = await call({ token: t, method: 'GET', path: '/posts' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'not_eligible', details: { reason: 'apps_disabled' } });
  });
});

describe('rate limits: separate buckets', () => {
  it('reads: 300 per minute per (app, viewer); anonymous readers per IP; writes and other viewers unaffected', async () => {
    const { A, B } = freshApps();
    const v1 = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    const v1b = await mint({ app: B, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    const v2 = await mint({ app: A, uid: VIEWER_IDS.v2, scopes: contract.defaultScopes });
    const anon = await mint({ app: A, uid: null, scopes: ['apps:storage'] });
    for (let i = 0; i < 300; i++) {
      expect((await call({ token: v1, method: 'GET', path: '/posts/x' })).status).toBe(404);
    }
    const refused = await call({ token: v1, method: 'GET', path: '/posts/x' });
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: 'rate_limited', details: { bucket: 'read' } });
    expect(refused.headers['retry-after']).toBe('60');
    expect(
      (await call({ token: v1, method: 'PUT', path: '/prefs/w', body: { data: {} } })).status
    ).toBe(200);
    expect((await call({ token: v1b, method: 'GET', path: '/posts/x' })).status).toBe(404);
    expect((await call({ token: v2, method: 'GET', path: '/posts/x' })).status).toBe(404);

    for (let i = 0; i < 300; i++) {
      expect(
        (await call({ token: anon, method: 'GET', path: '/posts/x', ip: '203.0.113.9' })).status
      ).toBe(404);
    }
    expect(
      (await call({ token: anon, method: 'GET', path: '/posts/x', ip: '203.0.113.9' })).status
    ).toBe(429);
    expect(
      (await call({ token: anon, method: 'GET', path: '/posts/x', ip: '203.0.113.10' })).status
    ).toBe(404);
  });

  it('private writes: 120 per minute per (app, viewer); reads unaffected', async () => {
    const { A } = freshApps();
    // Room for 121 documents, so the store's own ceiling cannot be what refuses.
    h.store = createDocStore({ db: harness.db, limits: DEFAULT_DOC_STORE_LIMITS });
    const v1 = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    for (let i = 0; i < 120; i++) {
      expect(
        (await call({ token: v1, method: 'PUT', path: '/prefs/same', body: { data: { i } } }))
          .status
      ).toBe(200);
    }
    const refused = await call({
      token: v1,
      method: 'PUT',
      path: '/prefs/same',
      body: { data: {} },
    });
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({
      code: 'rate_limited',
      details: { bucket: 'private-write' },
    });
    expect((await call({ token: v1, method: 'GET', path: '/prefs/same' })).body).toMatchObject({
      version: 120,
    });
  });

  it('shared document writes spend the existing shared write budget (burst 10); private writes do not', async () => {
    const { A } = freshApps();
    const v1 = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    for (let i = 0; i < 10; i++) {
      expect(
        (await call({ token: v1, method: 'PUT', path: `/posts/p${i}`, body: { data: {} } })).status
      ).toBe(200);
    }
    const refused = await call({
      token: v1,
      method: 'PUT',
      path: '/posts/p10',
      body: { data: {} },
    });
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({
      code: 'rate_limited',
      details: { bucket: 'shared-write' },
    });
    expect(
      (await call({ token: v1, method: 'PUT', path: '/prefs/k', body: { data: {} } })).status
    ).toBe(200);
  });

  it('a shared write refused by the store is charged as a rejection, and a refused body is not charged at all', async () => {
    const { A } = freshApps();
    const v1 = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    const v2 = await mint({ app: A, uid: VIEWER_IDS.v2, scopes: contract.defaultScopes });
    expect(
      (await call({ token: v1, method: 'PUT', path: '/posts/owned', body: { data: {} } })).status
    ).toBe(200);
    // 25 malformed bodies: refused before the budget is touched.
    for (let i = 0; i < 25; i++) {
      expect(
        (await call({ token: v2, method: 'PUT', path: '/posts/owned', body: { data: 1 } })).status
      ).toBe(400);
    }
    // not_author lands after the reservation: refunded to burst, charged to rejections (10).
    for (let i = 0; i < 10; i++) {
      expect(
        (await call({ token: v2, method: 'PUT', path: '/posts/owned', body: { data: {} } })).status
      ).toBe(403);
    }
    const refused = await call({
      token: v2,
      method: 'PUT',
      path: '/posts/other',
      body: { data: {} },
    });
    expect(refused.body).toMatchObject({
      code: 'rate_limited',
      details: { bucket: 'shared-write' },
    });
  });
});

describe('route faults and CORS', () => {
  it('an unexpected store fault is a 500 internal_error that discloses nothing', async () => {
    const { A } = freshApps();
    h.store = {
      ...liveStore,
      get: async () => {
        throw new Error('connection to 10.0.0.1 refused');
      },
    } as DocStore;
    const t = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    const r = await call({ token: t, method: 'GET', path: '/prefs/k' });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({
      code: 'internal_error',
      message: 'An unexpected error occurred',
      error: 'An unexpected error occurred',
    });
  });

  it('the preflight from an opaque origin allows PUT and DELETE', async () => {
    const r = await call({ token: null, method: 'OPTIONS', path: '/prefs/k', origin: 'null' });
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-methods']).toBe('GET, POST, PUT, DELETE, OPTIONS');
  });
});
