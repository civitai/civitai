// Setup-order import: installs the env mock with the test RSA keypair BEFORE the block-token
// service and the middleware read it at module load.
import '~/__tests__/setup';
import { readFileSync } from 'fs';
import { Readable } from 'stream';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as FliptClient from '~/server/flipt/client';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as SessionClientModule from '~/server/auth/session-client';
import type * as Moderation from '~/server/services/apps/shared-data-moderation';
import type * as SubListingService from '~/server/services/blocks/app-sub-listing.service';
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
  authorEnabled: true,
  /**
   * The app's shared-data moderation mode, as the two per-app Flipt flags give it. The contract's
   * moderation cases describe ENFORCE, so that is every test's default (reset in `beforeEach`).
   */
  moderationMode: 'enforce' as 'off' | 'shadow' | 'enforce',
  isFlipt: undefined as unknown as ReturnType<
    typeof vi.fn<(flag: string, entityId?: string, context?: unknown) => Promise<boolean>>
  >,
  /** ClickHouse inserts, captured only while a test sets `capture` (otherwise the real client). */
  ch: { capture: false, inserts: [] as { table: string; values: unknown[] }[] },
}));

const SHADOW_FLAG = 'app-blocks-shared-data-moderation';
const ENFORCE_FLAG = 'app-blocks-shared-data-moderation-enforce';
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const real = await importOriginal<typeof FliptClient>();
  h.isFlipt = vi.fn(async (flag: string, entityId?: string, context?: unknown) => {
    if (flag === SHADOW_FLAG) return h.moderationMode === 'shadow';
    if (flag === ENFORCE_FLAG) return h.moderationMode === 'enforce';
    return real.isFlipt(flag, entityId, context as never);
  });
  return {
    ...real,
    isFlipt: (flag: string, entityId?: string, context?: unknown) =>
      h.isFlipt(flag, entityId, context),
  };
});
vi.mock('~/server/clickhouse/client', async (importOriginal) => {
  const real = await importOriginal<typeof ClickhouseClient>();
  const capture = {
    insert: async (args: { table: string; values: unknown[] }) => {
      h.ch.inserts.push({ table: args.table, values: args.values });
    },
  };
  return {
    ...real,
    get clickhouse() {
      return h.ch.capture ? capture : real.clickhouse;
    },
  };
});

vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksRuntimeEnabled: vi.fn(async () => true),
  isAppBlocksEnabled: vi.fn(async () => h.runEnabled),
  isAppBlocksAuthorEnabled: vi.fn(async () => h.authorEnabled),
}));
vi.mock('~/server/auth/session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionClientModule>()),
  sessionClient: { getSessionUserById: vi.fn(async (id: number) => h.users.get(id) ?? null) },
}));
vi.mock('~/server/services/apps/doc-store.instance', () => ({ getDocStore: () => h.store }));
// The App Store card sync is recorded at its entry point (its own effect on the card rows is
// covered in `app-sub-listing.service.test.ts`).
const cardSync = vi.hoisted(() => ({ calls: [] as unknown[], fail: false }));
vi.mock('~/server/services/blocks/app-sub-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubListingService>()),
  syncSubListingForSharedRow: vi.fn(async (args: unknown) => {
    cardSync.calls.push(args);
    if (cardSync.fail) throw new Error('store card sync unavailable');
  }),
}));
// The scanner is replaced; `enforcedBlockingHit` (which hit refuses) stays real.
vi.mock('~/server/services/apps/shared-data-moderation', async (importOriginal) => {
  const real = await importOriginal<typeof Moderation>();
  // Distinctive, so a response that leaked either would be visible.
  const SECRET_MATCH = 'scanner-matched-text-zq81';
  const SECRET_LABEL = 'scanner-label-zq82';
  const verdict = (text: string): SharedTextScan => {
    if (text.includes('contract-scanner-down')) throw new Error('scanner outage');
    // The leaf is the scanned text, so a shadow record's `leafText` can be checked.
    const leaf = { raw: text, path: 't', segments: ['t'], kind: 'value' as const };
    const hit = (category: 'audit_regex' | 'link') => ({
      leafCount: 1,
      overflow: null,
      hits: [{ category, matched: SECRET_MATCH, label: SECRET_LABEL, leaf }],
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
import { createDocStore, createDocStoreMaintenance } from '~/server/services/apps/doc-store';
import { DEFAULT_DOC_STORE_LIMITS, DocStoreError } from '~/server/services/apps/doc-store.types';
import { OnboardingSteps } from '~/server/common/enums';
import {
  matchStorageRoute,
  STORAGE_BODY_LIMIT_BYTES,
  STORAGE_ERROR_STATUS,
  STORAGE_RESERVED_SEGMENTS,
  storageRefusalBody,
} from '~/server/services/apps/doc-store-api';
import type { BlockScopeRefusalKind } from '~/server/middleware/block-scope.middleware';
import {
  clampDevScopes,
  DEV_TOKEN_SCOPE_ALLOWLIST,
  signDevScopedPageToken,
} from '~/server/services/blocks/dev-scoped-mint.service';
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
  rawBody?: string;
  contentLength?: number;
  /** A body stream to use as the request instead of one built from `body` / `rawBody`. */
  stream?: Readable;
}): Promise<Reply> {
  const segments = opts.path.split('/').filter(Boolean);
  // The route reads its own body (Next's parser is off), so the request is a real stream of
  // the JSON text — or of `rawBody`, verbatim, to send something that is not JSON.
  const text =
    opts.rawBody !== undefined
      ? opts.rawBody
      : opts.body === undefined
      ? ''
      : JSON.stringify(opts.body);
  const req = Object.assign(opts.stream ?? Readable.from(text ? [Buffer.from(text)] : []), {
    method: opts.method,
    url: `/api/v1/blocks/storage${opts.path}`,
    query: { ...(opts.query ?? {}), ...(segments.length ? { path: segments } : {}) },
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.contentLength !== undefined ? { 'content-length': String(opts.contentLength) } : {}),
    },
    socket: { remoteAddress: opts.ip ?? '198.51.100.7' },
  }) as unknown as NextApiRequest;
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
        const scopes = step.scopes ?? contract.defaultScopes;
        token =
          step.token === 'dev'
            ? await mintDevReal(appRows[appLabel], VIEWER_IDS[who], scopes)
            : await mint({
                app: appRows[appLabel],
                uid: who === 'anon' ? null : VIEWER_IDS[who],
                scopes,
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
      // One envelope on every refusal, whichever layer refused.
      if (reply.status >= 400) {
        const b = reply.body as Record<string, unknown>;
        expect(typeof b.message, where).toBe('string');
        expect(b.error, where).toBe(b.message);
      }
    }
  }
}

/**
 * A dev token as the bearer `/api/v1/blocks/dev-token` route mints one for an APPROVED app:
 * the REAL clamp against `DEV_TOKEN_SCOPE_ALLOWLIST` (with an OAuth ceiling of 0, under which
 * only the no-OAuth-bit scopes survive), then the REAL shared signer.
 */
async function mintDevReal(app: AppRow, uid: number, scopeSource: string[]): Promise<string> {
  const granted = clampDevScopes({
    scopeSource,
    oauthAllowed: 0,
    spendEntitled: false,
    spendRequested: false,
    allowlist: DEV_TOKEN_SCOPE_ALLOWLIST,
  });
  const { token } = await signDevScopedPageToken({
    userId: uid,
    signBlockId: app.blockId,
    signAppId: app.appId,
    signAppBlockId: app.id,
    blockInstanceId: `page_${app.id}`,
    granted,
    buzzBudget: undefined,
  });
  return token;
}

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
  h.authorEnabled = true;
  h.moderationMode = 'enforce';
  h.ch.capture = false;
  h.ch.inserts = [];
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
    // Derived from the one status table; the exclusions are named, so a NEW code is required
    // here until a case reaches it or it is excluded with a reason.
    const UNREACHABLE_IN_PHASE_1: Record<string, string> = {
      service_unavailable: 'the approval read failed; pinned in the REST characterisation table',
      index_building: 'declared indexes are backfilled inline; nothing raises it yet',
      cursor_expired: 'change feed, a later phase',
      internal_error: 'an unexpected fault; its own test below',
      resource_not_owned:
        'needs model-version rows the request table cannot express; the ownedModelVersions block below',
    };
    const reachable = Object.keys(STORAGE_ERROR_STATUS).filter(
      (code) => !(code in UNREACHABLE_IN_PHASE_1)
    );
    expect(reachable.length).toBeGreaterThanOrEqual(18);
    expect(reachable.filter((code) => !used.has(code))).toEqual([]);
  });

  it('the matcher and the user-id check go red on what they must refuse (positive control)', () => {
    const errs = (actual: unknown, expected: unknown) => {
      const out: string[] = [];
      matches(actual, expected, '$', {}, out);
      return out.length;
    };
    expect(errs({ a: 1 }, { a: '$absent' })).toBe(1);
    expect(errs({ a: 0 }, { a: '$null' })).toBe(1);
    expect(errs([1, 2], [1])).toBe(1);
    expect(errs({ a: { b: 2 } }, { a: { b: 3 } })).toBe(1);
    expect(errs('x', '$iso')).toBe(1);
    expect(errs({ a: 1, extra: 2 }, { a: 1 })).toBe(0);
    const uid = [...ALL_UIDS][0];
    expect(() => assertNoUserId({ author: { id: uid } }, 'control')).toThrow();
    expect(() => assertNoUserId({ author: { uid: 5 } }, 'control')).toThrow();
    expect(() => assertNoUserId({ s: `cursor~${uid}` }, 'control')).toThrow();
    expect(() => assertNoUserId({ ok: 1 }, 'control')).not.toThrow();
  });
});

describe('contract cases against the real handlers', () => {
  it.each(contract.cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    await runCase(c);
  });
});

describe('reserved path segments cannot collide with a collection name or a document key', () => {
  it('each reserved segment is outside the alphabet at its own position, or is parsed as a value everywhere else', () => {
    for (const { segment, position } of STORAGE_RESERVED_SEGMENTS) {
      if (position === 0) {
        // At the collection position: a leading `_` is outside the collection alphabet, and
        // the word cannot be a collection on any route.
        expect(APP_STORAGE_COLLECTION_NAME_RE.test(segment), segment).toBe(false);
        expect(matchStorageRoute('GET', [segment])).toBeNull();
      }
      // As a document KEY (the second segment) every reserved word is a valid key and is
      // parsed as exactly that key, on every document route.
      expect(DOC_STORE_BOUNDS.key.test(segment), segment).toBe(true);
      expect(matchStorageRoute('GET', ['c', segment])).toEqual({
        route: { op: 'get', collection: 'c', key: segment },
      });
      expect(matchStorageRoute('POST', ['c', segment, 'counters', 'n'])).toEqual({
        route: { op: 'increment', collection: 'c', key: segment, name: 'n' },
      });
      // As a COLLECTION, every reserved word the collection alphabet admits is parsed as one.
      if (APP_STORAGE_COLLECTION_NAME_RE.test(segment)) {
        expect(matchStorageRoute('GET', [segment])).toEqual({
          route: { op: 'list', collection: segment },
        });
        expect(matchStorageRoute('PUT', [segment, segment, 'marks', segment])).toEqual({
          route: { op: 'mark', collection: segment, key: segment, name: segment },
        });
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
  it('a REAL dev mint carries both storage scopes and writes dev:<uid> under the approved app id', async () => {
    const { A } = freshApps();
    const dev = await mintDevReal(A, VIEWER_IDS.v2, contract.defaultScopes);
    const put = await call({
      token: dev,
      method: 'PUT',
      path: '/posts/devkey',
      body: { data: { from: 'dev' } },
    });
    expect(put.status).toBe(200);
    const rows = await harness.raw(`SELECT app_id, ns FROM appdata.doc WHERE key = 'devkey'`);
    expect(rows).toEqual([{ app_id: A.id, ns: `dev:${VIEWER_IDS.v2}` }]);
    // Invisible to the same viewer in production, and to another developer's namespace.
    const prod = await mint({ app: A, uid: VIEWER_IDS.v2, scopes: contract.defaultScopes });
    expect((await call({ token: prod, method: 'GET', path: '/posts/devkey' })).status).toBe(404);
    const other = await mintDevReal(A, VIEWER_IDS.v1, contract.defaultScopes);
    expect((await call({ token: other, method: 'GET', path: '/posts/devkey' })).status).toBe(404);
  });

  it('a REAL dev mint for an app that is not approved gets no storage', async () => {
    const { A } = freshApps('pending');
    const dev = await mintDevReal(A, VIEWER_IDS.v2, contract.defaultScopes);
    const r = await call({ token: dev, method: 'GET', path: '/prefs/k' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'not_eligible', details: { reason: 'app_not_approved' } });
  });

  /** A token from the REAL run-for-real review mint, for `uid` reviewing `pubreq`. */
  async function realReviewMint(
    pubreq: { id: string; status: string; slug: string; manifest: unknown },
    uid: number
  ): Promise<{ token: string; scopes: string[] }> {
    const { mintReviewBlockToken } = await import(
      '~/server/services/blocks/publish-request.service'
    );
    dbMock.dbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pubreq);
    const minted = await mintReviewBlockToken({
      publishRequestId: pubreq.id,
      modUserId: uid,
      runForReal: true,
    });
    return minted as { token: string; scopes: string[] };
  }

  it("the REAL review run-for-real mint carries both storage scopes and reaches the store, in the moderator's own namespace", async () => {
    freshApps();
    const pubreq = {
      id: 'pubreq_01JREVIEWREALMINT0000000',
      status: 'pending',
      slug: 'review-real-mint',
      manifest: MANIFEST,
    };
    publishRequests.push(pubreq);
    const { token, scopes } = await realReviewMint(pubreq, VIEWER_IDS.v1);
    expect(scopes).toEqual(['apps:storage', 'apps:storage:publish', 'user:read:self']);
    const put = await call({ token, method: 'PUT', path: '/prefs/k', body: { data: { a: 1 } } });
    expect(put.status).toBe(200);
    const shared = await call({
      token,
      method: 'PUT',
      path: '/posts/p1',
      body: { data: { status: 'open' } },
    });
    expect(shared.status).toBe(200);
    const rows = await harness.raw(
      `SELECT app_id, ns, coll FROM appdata.doc WHERE app_id = $1 ORDER BY coll`,
      [pubreq.id]
    );
    expect(rows).toEqual([
      { app_id: pubreq.id, ns: `rev:${pubreq.id}:${VIEWER_IDS.v1}`, coll: 'posts' },
      { app_id: pubreq.id, ns: `rev:${pubreq.id}:${VIEWER_IDS.v1}`, coll: 'prefs' },
    ]);
  });

  it('two moderators reviewing ONE request share nothing: private and shared docs, marks, counters', async () => {
    freshApps();
    const pubreq = {
      id: 'pubreq_01JREVIEWTWOMODS00000000',
      status: 'pending',
      slug: 'review-two-mods',
      manifest: MANIFEST,
    };
    publishRequests.push(pubreq);
    const m1 = (await realReviewMint(pubreq, VIEWER_IDS.v1)).token;
    const m2 = (await realReviewMint(pubreq, VIEWER_IDS.v2)).token;
    const req = (token: string, method: string, path: string, body?: unknown) =>
      call({ token, method, path, body });

    // Moderator 1 writes a private doc, a shared doc, a mark, a counter and a counter-created doc.
    expect((await req(m1, 'PUT', '/prefs/k', { data: { who: 1 } })).status).toBe(200);
    expect((await req(m1, 'PUT', '/posts/p1', { data: { status: 'open' } })).status).toBe(200);
    expect((await req(m1, 'PUT', '/posts/p1/marks/vote')).body).toMatchObject({ count: 1 });
    expect((await req(m1, 'POST', '/posts/p1/counters/views', { by: 5 })).body).toEqual({
      value: 5,
    });
    expect((await req(m1, 'POST', '/plays/g1/counters/plays', { by: 3 })).body).toEqual({
      value: 3,
    });

    // Moderator 2 sees none of it.
    expect((await req(m2, 'GET', '/prefs/k')).status).toBe(404);
    expect((await req(m2, 'GET', '/posts/p1')).status).toBe(404);
    expect((await req(m2, 'GET', '/plays/g1')).status).toBe(404);
    expect((await req(m2, 'GET', '/posts')).body).toMatchObject({ items: [] });
    // The same keys are fresh for moderator 2: no `not_author` on moderator 1's shared doc,
    // and marks and counters start from zero.
    expect((await req(m2, 'PUT', '/posts/p1', { data: { status: 'closed' } })).body).toMatchObject({
      version: 1,
      author: { kind: 'user', isViewer: true },
    });
    expect((await req(m2, 'PUT', '/posts/p1/marks/vote')).body).toMatchObject({ count: 1 });
    expect((await req(m2, 'POST', '/posts/p1/counters/views', { by: 2 })).body).toEqual({
      value: 2,
    });
    expect((await req(m2, 'POST', '/plays/g1/counters/plays', { by: 1 })).body).toEqual({
      value: 1,
    });

    // …and moderator 1's own data is unchanged by moderator 2's writes.
    expect((await req(m1, 'GET', '/posts/p1')).body).toMatchObject({
      data: { status: 'open' },
      version: 1,
      counters: { views: 5 },
      marks: { vote: 1 },
    });
    expect((await req(m1, 'GET', '/plays/g1')).body).toMatchObject({ counters: { plays: 3 } });
    expect((await req(m1, 'GET', '/posts')).body).toMatchObject({
      items: [{ key: 'p1', data: { status: 'open' } }],
    });
    // Two namespaces, one per moderator, for the one request.
    const ns = await harness.raw(
      `SELECT DISTINCT ns FROM appdata.doc WHERE app_id = $1 ORDER BY ns`,
      [pubreq.id]
    );
    expect(ns.map((r) => r.ns)).toEqual(
      [`rev:${pubreq.id}:${VIEWER_IDS.v1}`, `rev:${pubreq.id}:${VIEWER_IDS.v2}`].sort()
    );

    // The purge a decision runs finds exactly the namespaces the route wrote: nothing of the
    // request is left in any table. A delete first, so the tombstone table has a row too, and a
    // positive control that every table HAS rows before the purge.
    expect((await req(m1, 'PUT', '/notes/n1', { data: { t: 'x' } })).status).toBe(200);
    expect((await req(m1, 'DELETE', '/notes/n1')).status).toBe(200);
    const TABLES = [
      'doc',
      'doc_index',
      'doc_tally',
      'doc_mark',
      'doc_tomb',
      'usage_app',
      'usage_user',
    ];
    const count = async (t: string) =>
      Number(
        (
          await harness.raw(`SELECT count(*)::int AS n FROM appdata.${t} WHERE app_id = $1`, [
            pubreq.id,
          ])
        )[0].n
      );
    for (const t of TABLES) expect({ t, rows: (await count(t)) > 0 }).toEqual({ t, rows: true });
    expect(
      (await createDocStoreMaintenance({ db: harness.db }).purgeReview(pubreq.id)).rows
    ).toBeGreaterThan(0);
    for (const t of TABLES) expect({ t, rows: await count(t) }).toEqual({ t, rows: 0 });
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
      details: { bucket: 'write' },
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

describe('a report cannot be withdrawn: refused at the route before any budget or trust lookup', () => {
  it('an untrusted viewer gets 400 invalid_request, not 403', async () => {
    const { A } = freshApps();
    const author = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    const newbie = await mint({ app: A, uid: VIEWER_IDS.newbie, scopes: contract.defaultScopes });
    expect(
      (
        await call({
          token: author,
          method: 'PUT',
          path: '/posts/w',
          body: { data: { status: 'open' } },
        })
      ).status
    ).toBe(200);
    // Positive control: the same viewer IS refused by the trust gate on a mark.
    expect((await call({ token: newbie, method: 'PUT', path: '/posts/w/marks/vote' })).status).toBe(
      403
    );
    const r = await call({ token: newbie, method: 'DELETE', path: '/posts/w/marks/report' });
    expect({ status: r.status, code: r.body.code }).toEqual({
      status: 400,
      code: 'invalid_request',
    });
  });

  it('an exhausted tally budget still gets 400, and a refused withdrawal spends no budget', async () => {
    const { A } = freshApps();
    const v1 = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    const v2 = await mint({ app: A, uid: VIEWER_IDS.v2, scopes: contract.defaultScopes });
    await call({ token: v1, method: 'PUT', path: '/posts/w', body: { data: { status: 'open' } } });
    // v2 withdraws first (refused), then must still have the WHOLE tally budget.
    const first = await call({ token: v2, method: 'DELETE', path: '/posts/w/marks/report' });
    expect(first.status).toBe(400);
    let allowed = 0;
    for (let i = 0; i < 200; i++) {
      const r = await call({ token: v2, method: 'PUT', path: '/posts/w/marks/vote' });
      if (r.status === 429) break;
      expect(r.status).toBe(200);
      allowed += 1;
    }
    // The bucket's full size, measured on a viewer that never withdrew.
    const v3 = await mint({ app: A, uid: VIEWER_IDS.v3, scopes: contract.defaultScopes });
    let control = 0;
    for (let i = 0; i < 200; i++) {
      const r = await call({ token: v3, method: 'PUT', path: '/posts/w/marks/vote' });
      if (r.status === 429) break;
      control += 1;
    }
    expect(control).toBeGreaterThan(1);
    expect(allowed).toBe(control);
    // Exhausted now: a withdrawal is still the contract's 400, not a 429.
    const r = await call({ token: v2, method: 'DELETE', path: '/posts/w/marks/report' });
    expect({ status: r.status, code: r.body.code }).toEqual({
      status: 400,
      code: 'invalid_request',
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

describe('review findings: refusal detail, usage, budget refunds, review gates, CORS', () => {
  it('a moderation refusal carries only the coarse category — never the matched text or label', async () => {
    const { A } = freshApps();
    const t = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    const r = await call({
      token: t,
      method: 'PUT',
      path: '/posts/p1',
      body: { data: { t: 'contract-blocked-term' } },
    });
    expect(r.status).toBe(422);
    expect((r.body as { details: unknown }).details).toEqual({ category: 'blocked' });
    expect(JSON.stringify(r.body)).not.toMatch(/scanner-matched-text-zq81|scanner-label-zq82/);
  });

  it("info: the viewer's usage is their own, distinct from the app's and another viewer's", async () => {
    const { A } = freshApps();
    const v1 = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    const v2 = await mint({ app: A, uid: VIEWER_IDS.v2, scopes: contract.defaultScopes });
    for (const k of ['a', 'b', 'c']) {
      const r = await call({ token: v2, method: 'PUT', path: `/prefs/${k}`, body: { data: {} } });
      expect(r.status).toBe(200);
    }
    const mine = await call({
      token: v1,
      method: 'PUT',
      path: '/prefs/mine',
      body: { data: { x: 1 } },
    });
    expect(mine.status).toBe(200);
    const info = (await call({ token: v1, method: 'GET', path: '' })).body as {
      usage: { app: { docs: number; bytes: number }; viewer: { docs: number; bytes: number } };
    };
    expect(info.usage.app.docs).toBe(4);
    expect(info.usage.viewer.docs).toBe(1);
    expect(info.usage.viewer.bytes).toBeLessThan(info.usage.app.bytes);
  });

  it('a refused write is refunded to the burst: 5 not_author refusals, then 6 writes all land', async () => {
    const { A } = freshApps();
    const v1 = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    const v2 = await mint({ app: A, uid: VIEWER_IDS.v2, scopes: contract.defaultScopes });
    const owned = await call({
      token: v1,
      method: 'PUT',
      path: '/posts/owned',
      body: { data: {} },
    });
    expect(owned.status).toBe(200);
    for (let i = 0; i < 5; i++) {
      const r = await call({ token: v2, method: 'PUT', path: '/posts/owned', body: { data: {} } });
      expect(r.status).toBe(403);
    }
    for (let i = 0; i < 6; i++) {
      const r = await call({
        token: v2,
        method: 'PUT',
        path: `/posts/v2-${i}`,
        body: { data: {} },
      });
      expect(r.status).toBe(200);
    }
  });

  it('a moderation outage is our fault: refunded and NOT charged as a rejection', async () => {
    const { A } = freshApps();
    const v1 = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    for (let i = 0; i < 12; i++) {
      const r = await call({
        token: v1,
        method: 'PUT',
        path: '/posts/x',
        body: { data: { t: 'contract-scanner-down' } },
      });
      expect(r.status).toBe(503);
    }
    // 12 outages exceed the 10-token rejection bucket: had they been charged, this refuses.
    const after = await call({ token: v1, method: 'PUT', path: '/posts/x', body: { data: {} } });
    expect(after.status).toBe(200);
  });

  it('a write that landed spends its token even if presenting it fails afterwards', async () => {
    const { A } = freshApps();
    const v1 = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    // The username lookup for the showAuthor collection runs after the store has committed.
    dbMock.dbRead.user.findMany.mockRejectedValueOnce(new Error('replica blip'));
    dbMock.dbRead.user.findMany.mockRejectedValueOnce(new Error('replica blip'));
    dbMock.dbRead.user.findMany.mockRejectedValueOnce(new Error('replica blip'));
    dbMock.dbRead.user.findMany.mockRejectedValueOnce(new Error('replica blip'));
    dbMock.dbRead.user.findMany.mockRejectedValueOnce(new Error('replica blip'));
    for (let i = 0; i < 5; i++) {
      const r = await call({ token: v1, method: 'PUT', path: `/posts/l${i}`, body: { data: {} } });
      expect(r.status).toBe(500);
    }
    const rows = await harness.raw(`SELECT count(*)::int AS n FROM appdata.doc WHERE app_id = $1`, [
      A.id,
    ]);
    expect(rows).toEqual([{ n: 5 }]);
    // Five landed writes spent five of the 10-token burst: five more land, the sixth is refused.
    // Refunding a landed write would let the sixth through (and rejections would not bind yet).
    for (let i = 5; i < 10; i++) {
      const r = await call({ token: v1, method: 'PUT', path: `/posts/l${i}`, body: { data: {} } });
      expect(r.status).toBe(200);
    }
    const refused = await call({
      token: v1,
      method: 'PUT',
      path: '/posts/l10',
      body: { data: {} },
    });
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({
      code: 'rate_limited',
      details: { bucket: 'shared-write' },
      rateLimit: { retryAfterSeconds: expect.any(Number), retryAt: expect.any(String) },
    });
  });

  // Hand-signed review tokens, so each resolver gate below is reached on its own (the REAL
  // run-for-real mint is exercised above).
  it('resolver review branch (hand-signed): rev namespace, author capability, sign-in, pending request', async () => {
    {
      const pr = { id: 'pubreq_01JREVIEWNAMESPACE00000000', status: 'pending', manifest: MANIFEST };
      publishRequests.push(pr);
      const t = await mint({
        app: { id: pr.id, appId: 'appblk-review', blockId: 'review-slug' },
        uid: VIEWER_IDS.v1,
        scopes: contract.defaultScopes,
        dev: true,
        reviewRunForReal: true,
      });
      const put = await call({ token: t, method: 'PUT', path: '/prefs/k', body: { data: {} } });
      expect(put.status).toBe(200);
      const rows = await harness.raw(
        `SELECT app_id, ns FROM appdata.doc WHERE key = 'k' AND app_id = $1`,
        [pr.id]
      );
      expect(rows).toEqual([{ app_id: pr.id, ns: `rev:${pr.id}:${VIEWER_IDS.v1}` }]);
    }
    freshApps();
    const pubreq = { id: 'pubreq_01JREVIEWGATES0000000000', status: 'pending', manifest: MANIFEST };
    publishRequests.push(pubreq);
    const app = { id: pubreq.id, appId: 'appblk-review-gates', blockId: 'review-gates' };
    const review = (uid: number | null, a = app) =>
      mint({ app: a, uid, scopes: contract.defaultScopes, dev: true, reviewRunForReal: true });

    h.authorEnabled = false;
    const notAuthor = await call({
      token: await review(VIEWER_IDS.v1),
      method: 'GET',
      path: '/prefs/k',
    });
    expect(notAuthor.body).toMatchObject({
      code: 'not_eligible',
      details: { reason: 'author_required' },
    });
    h.authorEnabled = true;
    const ok = await call({ token: await review(VIEWER_IDS.v1), method: 'GET', path: '/prefs/k' });
    expect(ok.status).toBe(404);

    const anon = await call({ token: await review(null), method: 'GET', path: '/prefs/k' });
    expect(anon.body).toMatchObject({ code: 'sign_in_required' });

    const missing = { ...app, id: 'pubreq_01JREVIEWMISSING000000000' };
    const gone = await call({
      token: await review(VIEWER_IDS.v1, missing),
      method: 'GET',
      path: '/prefs/k',
    });
    expect(gone.body).toMatchObject({
      code: 'not_eligible',
      details: { reason: 'review_inactive' },
    });
  });

  it('the preflight from an ALLOWLISTED origin allows PUT and DELETE too', async () => {
    const { _internalsForTests } = await import('~/server/middleware/block-scope.middleware');
    _internalsForTests.resetOriginCache();
    dbMock.dbRead.oauthClient.findMany.mockResolvedValue([
      { allowedOrigins: ['https://contract-app.example'] },
    ]);
    const r = await call({
      token: null,
      method: 'OPTIONS',
      path: '/prefs/k',
      origin: 'https://contract-app.example',
    });
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('https://contract-app.example');
    expect(r.headers['access-control-allow-methods']).toBe('GET, POST, PUT, DELETE, OPTIONS');
    _internalsForTests.resetOriginCache();
  });

  it('moderators keep their pattern-list exemption: the scanner is told who is writing', async () => {
    const { scanSharedData, scanCounterKey } = await import(
      '~/server/services/apps/shared-data-moderation'
    );
    const { A } = freshApps();
    h.users.set(VIEWER_IDS.v3, { ...user('v3', true), isModerator: true });
    const mod = await mint({ app: A, uid: VIEWER_IDS.v3, scopes: contract.defaultScopes });
    const plain = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    vi.mocked(scanSharedData).mockClear();
    vi.mocked(scanCounterKey).mockClear();
    expect(
      (await call({ token: mod, method: 'PUT', path: '/posts/m', body: { data: {} } })).status
    ).toBe(200);
    expect(vi.mocked(scanSharedData).mock.calls.at(-1)?.[1]).toEqual({ isModerator: true });
    expect(vi.mocked(scanCounterKey).mock.calls.at(-1)?.[1]).toEqual({ isModerator: true });
    expect(
      (await call({ token: plain, method: 'PUT', path: '/posts/p', body: { data: {} } })).status
    ).toBe(200);
    expect(vi.mocked(scanSharedData).mock.calls.at(-1)?.[1]).toEqual({ isModerator: false });
  });

  it.each([
    ['a raw database error', () => new Error('connection refused')],
    ['storage_disabled', () => new DocStoreError('storage_disabled', 'disabled')],
    [
      'lock contention',
      () => new DocStoreError('rate_limited', 'busy', { reason: 'contention', retryAfter: 1 }),
    ],
  ])(
    '%s on a shared write is our fault: refunded, never charged as a rejection',
    async (_n, make) => {
      const { A } = freshApps();
      const v1 = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
      h.store = { ...liveStore, put: async () => Promise.reject(make()) } as DocStore;
      for (let i = 0; i < 12; i++) {
        const r = await call({ token: v1, method: 'PUT', path: '/posts/x', body: { data: {} } });
        expect(r.status).toBeGreaterThanOrEqual(429);
      }
      h.store = liveStore;
      // 12 failures exceed the 10-token rejection bucket: had they been charged, this refuses.
      const after = await call({ token: v1, method: 'PUT', path: '/posts/x', body: { data: {} } });
      expect(after.status).toBe(200);
    }
  );

  it('every middleware refusal maps to a storage code whose status is the one the middleware sends', () => {
    const STATUS_SENT: Record<BlockScopeRefusalKind, number> = {
      invalid_token: 401,
      instance_revoked: 403,
      permission_state_unavailable: 503,
      consent_revoked: 403,
      app_not_approved: 403,
      approval_unavailable: 503,
      insufficient_scope: 403,
      context_binding: 403,
    };
    for (const [kind, status] of Object.entries(STATUS_SENT) as [BlockScopeRefusalKind, number][]) {
      const body = storageRefusalBody({ kind, status, error: `e-${kind}` }, {
        method: 'GET',
        query: {},
      } as unknown as NextApiRequest);
      expect(STORAGE_ERROR_STATUS[body.code], kind).toBe(status);
      expect(body.message, kind).toBe(`e-${kind}`);
      expect(body.error, kind).toBe(`e-${kind}`);
    }
  });

  it('a bad token on this route answers in the storage envelope', async () => {
    const r = await call({ token: 'aaa.bbb.ccc', method: 'GET', path: '/prefs/k' });
    // Not a JWT the middleware recognises → handed to the handler with no claims.
    expect(r.body).toMatchObject({ code: 'unauthenticated' });
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'x' })).toString(
      'base64url'
    );
    const forged = `${header}.${Buffer.from('{}').toString('base64url')}.c2ln`;
    const bad = await call({ token: forged, method: 'GET', path: '/prefs/k' });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({
      code: 'unauthenticated',
      message: 'invalid block token',
      error: 'invalid block token',
    });
  });
});

describe('round 1: approved manifests, dot keys, CORS default, failures, deletes', () => {
  const BUDGETED = {
    scopes: contract.defaultScopes,
    storage: {
      collections: {
        prefs: { visibility: 'private' },
        posts: { visibility: 'shared', write: 'own' },
        budgeted: { visibility: 'shared', write: 'own', dailyWritesPerAuthor: 50 },
      },
    },
  };

  it('an approved manifest using a deferred field keeps every collection declared; only that one is refused, by the store', async () => {
    const { A } = freshApps('approved', BUDGETED);
    const t = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    expect(
      (await call({ token: t, method: 'PUT', path: '/prefs/k', body: { data: {} } })).status
    ).toBe(200);
    expect(
      (await call({ token: t, method: 'PUT', path: '/posts/k', body: { data: {} } })).status
    ).toBe(200);
    for (const [method, path] of [
      ['PUT', '/budgeted/k'],
      ['GET', '/budgeted/k'],
      ['GET', '/budgeted'],
    ] as const) {
      const r = await call({
        token: t,
        method,
        path,
        body: method === 'PUT' ? { data: {} } : undefined,
      });
      expect(r.status, `${method} ${path}`).toBe(400);
      expect(r.body).toMatchObject({
        code: 'invalid_request',
        message: 'dailyWritesPerAuthor is not supported yet',
        details: { collection: 'budgeted' },
      });
    }
    const info = (await call({ token: t, method: 'GET', path: '' })).body as {
      collections: Record<string, unknown>;
    };
    expect(Object.keys(info.collections).sort()).toEqual(['budgeted', 'posts', 'prefs']);
  });

  it('a manifest whose storage does not parse at all is a retryable 503, logged once per app, never "not declared"', async () => {
    const { A } = freshApps('approved', {
      scopes: contract.defaultScopes,
      storage: { collections: { prefs: { visibility: 'nope' } } },
    });
    const { ensureRegisterAppBlockRuntimeMetrics } = await import(
      '~/server/metrics/app-block-runtime.metrics'
    );
    const counter = ensureRegisterAppBlockRuntimeMetrics().storageManifestUnparseableTotal;
    const before = (await counter.get()).values[0]?.value ?? 0;
    loggingMock.logToAxiom.mockClear();
    const t = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    for (let i = 0; i < 3; i++) {
      const r = await call({ token: t, method: 'GET', path: '/prefs/k' });
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ code: 'service_unavailable', details: { retryAfter: 30 } });
      expect(r.headers['retry-after']).toBe('30');
    }
    expect((await counter.get()).values[0]?.value).toBe(before + 3);
    const logged = loggingMock.logToAxiom.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as { name?: string }).name === 'app-blocks-doc-store-manifest-unparseable'
    );
    expect(logged).toHaveLength(1);
  });

  it('a failed database read in the resolver is a retryable 503 with Retry-After', async () => {
    const { A } = freshApps();
    const t = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    const real = dbMock.dbRead.appBlock.findUnique.getMockImplementation();
    dbMock.dbRead.appBlock.findUnique.mockImplementation(
      async (args: { where: { id?: string } }) => {
        if (args.where.id) throw new Error('replica unreachable');
        return real?.(args);
      }
    );
    const r = await call({ token: t, method: 'GET', path: '/prefs/k' });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'service_unavailable' });
    expect(r.headers['retry-after']).toBe('1');
  });

  it('dot-only keys: why they cannot be addressed, and that the store refuses them', async () => {
    // A URL client resolves dot segments before sending: this DELETE of a mark on key `..`
    // arrives as a DELETE of key `vote` in collection `marks`.
    expect(new URL('https://h.example/api/v1/blocks/storage/posts/../marks/vote').pathname).toBe(
      '/api/v1/blocks/storage/marks/vote'
    );
    expect(matchStorageRoute('DELETE', ['marks', 'vote'])).toEqual({
      route: { op: 'delete', collection: 'marks', key: 'vote' },
    });
    const app = { appId: 'ab_DOTKEYS', ns: 'prod', viewerUid: VIEWER_IDS.v1 };
    const prefs = {
      name: 'prefs',
      config: parseManifestStorage(MANIFEST).collections.get('prefs')!,
    };
    for (const key of ['.', '..', '...', '.'.repeat(128)]) {
      await expect(liveStore.put(app, prefs, key, {})).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
    // Dots inside a key are fine.
    expect((await liveStore.put(app, prefs, 'a..b', {})).key).toBe('a..b');
  });

  it('a route that does not opt into extraCorsMethods keeps GET, POST, OPTIONS on its preflight', async () => {
    const { withBlockScope } = await import('~/server/middleware/block-scope.middleware');
    const plain = withBlockScope(async () => undefined, {
      endpoint: 'storage_read',
      requiredScope: 'apps:storage',
      allowOpaqueOrigin: true,
    });
    const headers: Record<string, unknown> = {};
    let status = 0;
    const res = {
      setHeader: (k: string, v: unknown) => {
        headers[k.toLowerCase()] = v;
      },
      status: (c: number) => {
        status = c;
        return { end: () => undefined };
      },
    };
    await plain(
      { method: 'OPTIONS', headers: { origin: 'null' }, query: {} } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );
    expect(status).toBe(204);
    expect(headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
  });

  it('a malformed or oversized body is answered in the envelope, with the CORS headers set', async () => {
    const { A } = freshApps();
    const t = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    const bad = await call({
      token: t,
      method: 'PUT',
      path: '/prefs/k',
      rawBody: '{not json',
      origin: 'null',
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({
      code: 'invalid_request',
      message: 'request body is not valid JSON',
    });
    expect(bad.headers['access-control-allow-origin']).toBe('null');
    const big = await call({
      token: t,
      method: 'PUT',
      path: '/prefs/k',
      rawBody: 'x'.repeat(STORAGE_BODY_LIMIT_BYTES + 1),
      origin: 'null',
    });
    expect(big.status).toBe(413);
    expect(big.body).toMatchObject({
      code: 'too_large',
      details: { limit: STORAGE_BODY_LIMIT_BYTES },
    });
    expect(big.headers['access-control-allow-origin']).toBe('null');
    const declared = await call({
      token: t,
      method: 'PUT',
      path: '/prefs/k',
      rawBody: '{}',
      contentLength: STORAGE_BODY_LIMIT_BYTES + 1,
    });
    expect(declared.status).toBe(413);
  });

  it('a viewer can always delete their own shared documents with apps:storage alone; creating and updating still need publish and trust', async () => {
    const { A } = freshApps();
    const full = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    for (const k of ['a', 'b', 'c']) {
      expect(
        (await call({ token: full, method: 'PUT', path: `/posts/${k}`, body: { data: {} } })).status
      ).toBe(200);
    }
    // Publish never granted on this token.
    const baseOnly = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: ['apps:storage'] });
    expect((await call({ token: baseOnly, method: 'DELETE', path: '/posts/a' })).body).toEqual({
      deleted: true,
    });
    expect(
      (await call({ token: baseOnly, method: 'PUT', path: '/posts/a', body: { data: {} } })).body
    ).toMatchObject({
      code: 'consent_required',
    });
    // Publish revoked while the token still carries it.
    kv.set(`${REDIS_KEYS.BLOCKS.CONSENT_REVOKED_SCOPES}:${VIEWER_IDS.v1}:${A.id}`, {
      value: JSON.stringify(['apps:storage:publish']),
      ttl: -1,
    });
    expect((await call({ token: full, method: 'DELETE', path: '/posts/b' })).body).toEqual({
      deleted: true,
    });
    expect(
      (await call({ token: full, method: 'PUT', path: '/posts/b', body: { data: {} } })).body
    ).toMatchObject({
      code: 'consent_required',
    });
    kv.clear();
    // Muted (fails the trust gate).
    h.users.set(VIEWER_IDS.v1, { ...user('v1', true), muted: true });
    expect((await call({ token: full, method: 'DELETE', path: '/posts/c' })).body).toEqual({
      deleted: true,
    });
    expect(
      (await call({ token: full, method: 'PUT', path: '/posts/c', body: { data: {} } })).body
    ).toMatchObject({
      code: 'not_eligible',
    });
    // Still only one's own: another viewer's document is not deletable.
    const v2 = await mint({ app: A, uid: VIEWER_IDS.v2, scopes: contract.defaultScopes });
    expect(
      (await call({ token: v2, method: 'PUT', path: '/posts/theirs', body: { data: {} } })).status
    ).toBe(200);
    expect(
      (await call({ token: baseOnly, method: 'DELETE', path: '/posts/theirs' })).body
    ).toMatchObject({
      code: 'not_author',
    });
  });

  it('a request body aborted mid-stream is refused quietly: no fault log, nothing written to the dead socket', async () => {
    const { A } = freshApps();
    const t = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    // The client disconnects while the route is reading: the first pull gets part of the
    // body, the next one finds the connection reset.
    let pulls = 0;
    const stream = new Readable({
      read() {
        pulls += 1;
        if (pulls === 1) this.push(Buffer.from('{"data":{"partial":'));
        else this.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
      },
    });
    loggingMock.logToAxiom.mockClear();
    const r = await call({ token: t, method: 'PUT', path: '/prefs/k', stream });
    expect(pulls).toBeGreaterThanOrEqual(2);
    // Nothing written: no status set and no body.
    expect(r.status).toBe(0);
    expect(r.body).toBeUndefined();
    const faults = loggingMock.logToAxiom.mock.calls.filter(
      (c: unknown[]) => (c[0] as { name?: string }).name === 'app-blocks-doc-store-route-fault'
    );
    expect(faults).toEqual([]);
    // Nothing reached the store.
    expect(await harness.raw(`SELECT 1 FROM appdata.doc WHERE app_id = $1`, [A.id])).toEqual([]);
  });

  it('a collection using a deferred feature is refused at the route: no tally charge, no write budget, no moderation scan', async () => {
    const { scanSharedData, scanCounterKey } = await import(
      '~/server/services/apps/shared-data-moderation'
    );
    const { A } = freshApps('approved', {
      scopes: contract.defaultScopes,
      storage: {
        collections: {
          budgeted: {
            visibility: 'shared',
            write: 'own',
            counters: ['n'],
            dailyWritesPerAuthor: 50,
          },
        },
      },
    });
    const t = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    vi.mocked(scanSharedData).mockClear();
    vi.mocked(scanCounterKey).mockClear();
    const evalsBefore = lua.calls.length;
    const inc = await call({ token: t, method: 'POST', path: '/budgeted/k/counters/n' });
    const put = await call({
      token: t,
      method: 'PUT',
      path: '/budgeted/k',
      body: { data: { t: 'x' } },
    });
    for (const r of [inc, put]) {
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({
        code: 'invalid_request',
        details: { collection: 'budgeted' },
      });
    }
    expect([...kv.keys()].filter((k) => k.includes(':docs-'))).toEqual([]);
    expect(lua.calls.length).toBe(evalsBefore);
    expect(vi.mocked(scanSharedData)).not.toHaveBeenCalled();
    expect(vi.mocked(scanCounterKey)).not.toHaveBeenCalled();
  });
});

describe('the App Store card follows the author deleting a shared document', () => {
  beforeEach(() => {
    cardSync.calls = [];
    cardSync.fail = false;
  });
  const put = (token: string, path: string) =>
    call({ token, method: 'PUT', path, body: { data: { title: path } } });
  const del = (token: string, path: string) => call({ token, method: 'DELETE', path });

  it("withdraws the author's card for that key in that app", async () => {
    const { A } = freshApps();
    const t = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    expect((await put(t, '/posts/card-1')).status).toBe(200);
    const out = await del(t, '/posts/card-1');
    expect(out).toMatchObject({ status: 200, body: { deleted: true } });
    expect(cardSync.calls).toEqual([
      { appBlockId: A.id, itemKey: 'card-1', change: 'withdrawn', authorUserId: VIEWER_IDS.v1 },
    ]);
  });

  it("another app's delete of the same key names only that app's card", async () => {
    const { A, B } = freshApps();
    const ta = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    const tb = await mint({ app: B, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    expect((await put(ta, '/posts/card-2')).status).toBe(200);
    expect((await put(tb, '/posts/card-2')).status).toBe(200);
    expect((await del(tb, '/posts/card-2')).body).toEqual({ deleted: true });
    expect(cardSync.calls).toEqual([
      { appBlockId: B.id, itemKey: 'card-2', change: 'withdrawn', authorUserId: VIEWER_IDS.v1 },
    ]);
  });

  it('a private document, a dev-namespace document and a delete that removed nothing leave cards alone', async () => {
    const { A } = freshApps();
    const t = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    expect((await put(t, '/prefs/card-3')).status).toBe(200);
    expect((await del(t, '/prefs/card-3')).body).toEqual({ deleted: true });
    const dev = await mintDevReal(A, VIEWER_IDS.v1, contract.defaultScopes);
    expect((await put(dev, '/posts/card-4')).status).toBe(200);
    expect((await del(dev, '/posts/card-4')).body).toEqual({ deleted: true });
    expect((await del(t, '/posts/never-written')).body).toEqual({ deleted: false });
    expect(cardSync.calls).toEqual([]);
    // Positive control: the same token's shared prod delete does sync.
    expect((await put(t, '/posts/card-5')).status).toBe(200);
    expect((await del(t, '/posts/card-5')).body).toEqual({ deleted: true });
    expect(cardSync.calls).toHaveLength(1);
  });

  it('a failing card sync never fails the delete', async () => {
    const { A } = freshApps();
    const t = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    expect((await put(t, '/posts/card-6')).status).toBe(200);
    cardSync.fail = true;
    expect(await del(t, '/posts/card-6')).toMatchObject({ status: 200, body: { deleted: true } });
    expect(cardSync.calls).toHaveLength(1);
    expect((await call({ token: t, method: 'GET', path: '/posts/card-6' })).status).toBe(404);
  });
});

describe('ownedModelVersions: a manifest-declared ownership rule on document data', () => {
  const POINTER = '/workflow/modelVersionId';
  // Model version id → owner. Distinct from every viewer id, and from each other.
  const V1_OWN = 4401;
  const V1_OWN_2 = 4402;
  const V2_OWN = 4403;
  const V1_DELETED_MODEL = 4404;
  const ruled = {
    visibility: 'shared',
    write: 'own',
    marks: ['vote'],
    counters: ['views'],
    ownedModelVersions: [POINTER],
  };
  const MANIFEST_OWNED = {
    scopes: contract.defaultScopes,
    storage: {
      collections: {
        picks: ruled,
        plain: { visibility: 'shared', write: 'own' },
      },
    },
  };
  const pick = (id: unknown) => ({ data: { title: 'mine', workflow: { modelVersionId: id } } });

  let lookups: number[][];
  beforeEach(() => {
    lookups = [];
    const rows = [
      { id: V1_OWN, owner: VIEWER_IDS.v1, deletedAt: null },
      { id: V1_OWN_2, owner: VIEWER_IDS.v1, deletedAt: null },
      { id: V2_OWN, owner: VIEWER_IDS.v2, deletedAt: null },
      { id: V1_DELETED_MODEL, owner: VIEWER_IDS.v1, deletedAt: new Date('2030-01-01Z') },
    ];
    dbMock.dbRead.modelVersion.findMany.mockImplementation((async ({
      where,
    }: {
      where: { id: { in: number[] } };
    }) => {
      lookups.push(where.id.in);
      return rows
        .filter((r) => where.id.in.includes(r.id))
        .map((r) => ({
          id: r.id,
          status: 'Published',
          model: { userId: r.owner, status: 'Published', deletedAt: r.deletedAt },
        }));
    }) as never);
  });

  async function setup() {
    const { scanSharedData } = await import('~/server/services/apps/shared-data-moderation');
    const { A } = freshApps('approved', MANIFEST_OWNED);
    const tokenOf = (uid: number) => mint({ app: A, uid, scopes: contract.defaultScopes });
    const scans = vi.mocked(scanSharedData);
    /** What a request spent: moderation scans, write-budget evals, rate-limit counters. */
    const spend = async <T>(fn: () => Promise<T>) => {
      scans.mockClear();
      const evals = lua.calls.length;
      const counters = [...kv.keys()].filter((k) => k.includes(':docs-')).length;
      const result = await fn();
      return {
        result,
        spent: {
          scans: scans.mock.calls.length,
          budgetEvals: lua.calls.length - evals,
          rateCounters: [...kv.keys()].filter((k) => k.includes(':docs-')).length - counters,
        },
      };
    };
    return { A, tokenOf, spend };
  }

  const NOTHING_SPENT = { scans: 0, budgetEvals: 0, rateCounters: 0 };
  const refusedBody = {
    code: 'resource_not_owned',
    message: 'the model version at this field is not one the author owns',
    error: 'the model version at this field is not one the author owns',
    details: { pointer: POINTER },
  };

  it("create: another user's version is refused 403 before moderation or any budget; the author's own lands", async () => {
    const { A, tokenOf, spend } = await setup();
    const v1 = await tokenOf(VIEWER_IDS.v1);

    for (const [method, path] of [
      ['POST', '/picks'],
      ['PUT', '/picks/new-key'],
    ] as const) {
      const { result, spent } = await spend(() =>
        call({ token: v1, method, path, body: pick(V2_OWN) })
      );
      expect(result.status, `${method} ${path}`).toBe(403);
      expect(result.body).toEqual(refusedBody);
      expect(spent, `${method} ${path}`).toEqual(NOTHING_SPENT);
    }
    expect(await harness.raw(`SELECT 1 FROM appdata.doc WHERE app_id = $1`, [A.id])).toEqual([]);

    // Positive control: the same instruments see an accepted shared write spend.
    const { result, spent } = await spend(() =>
      call({ token: v1, method: 'POST', path: '/picks', body: pick(V1_OWN) })
    );
    expect(result.status).toBe(201);
    expect(spent.scans).toBe(1);
    expect(spent.budgetEvals).toBeGreaterThan(0);
    expect(lookups).toContainEqual([V1_OWN]);
  });

  it("update: swapping someone else's version into the author's own document is refused, and the document is unchanged", async () => {
    const { tokenOf, spend } = await setup();
    const v1 = await tokenOf(VIEWER_IDS.v1);
    const created = await call({ token: v1, method: 'PUT', path: '/picks/k', body: pick(V1_OWN) });
    expect(created.status).toBe(200);

    const { result, spent } = await spend(() =>
      call({ token: v1, method: 'PUT', path: '/picks/k', body: { ...pick(V2_OWN), ifVersion: 1 } })
    );
    expect(result.status).toBe(403);
    expect(result.body).toEqual(refusedBody);
    expect(spent).toEqual(NOTHING_SPENT);
    const after = await call({ token: v1, method: 'GET', path: '/picks/k' });
    expect(after.body).toMatchObject({ version: 1, data: pick(V1_OWN).data });

    const swapOwn = await call({
      token: v1,
      method: 'PUT',
      path: '/picks/k',
      body: pick(V1_OWN_2),
    });
    expect(swapOwn.status).toBe(200);
    expect(swapOwn.body).toMatchObject({ version: 2, data: pick(V1_OWN_2).data });
  });

  it('an ownership lookup that fails is a retryable 503 with Retry-After: nothing written, nothing spent', async () => {
    const { A, tokenOf, spend } = await setup();
    const v1 = await tokenOf(VIEWER_IDS.v1);
    dbMock.dbRead.modelVersion.findMany.mockRejectedValueOnce(new Error('replica unreachable'));
    const { result, spent } = await spend(() =>
      call({ token: v1, method: 'POST', path: '/picks', body: pick(V1_OWN) })
    );
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      code: 'service_unavailable',
      details: { retryAfter: 1 },
    });
    expect(result.headers['retry-after']).toBe('1');
    expect(spent).toEqual(NOTHING_SPENT);
    expect(await harness.raw(`SELECT 1 FROM appdata.doc WHERE app_id = $1`, [A.id])).toEqual([]);
    // Control: the same write lands once the lookup answers.
    const ok = await call({ token: v1, method: 'POST', path: '/picks', body: pick(V1_OWN) });
    expect(ok.status).toBe(201);
  });

  it('a missing version, a deleted model and a value that is not an id are refused exactly like a stranger', async () => {
    const { tokenOf } = await setup();
    const v1 = await tokenOf(VIEWER_IDS.v1);
    const stranger = await call({ token: v1, method: 'POST', path: '/picks', body: pick(V2_OWN) });
    expect(stranger.status).toBe(403);
    lookups = [];
    for (const id of [
      987_654,
      V1_DELETED_MODEL,
      String(V1_OWN),
      V1_OWN + 0.5,
      -V1_OWN,
      0,
      2_147_483_648,
      null,
      true,
      [V1_OWN],
      { id: V1_OWN },
    ]) {
      const r = await call({ token: v1, method: 'POST', path: '/picks', body: pick(id) });
      expect({ status: r.status, body: r.body }, JSON.stringify(id)).toEqual({
        status: stranger.status,
        body: stranger.body,
      });
    }
    // Only well-formed ids reach the database; every malformed value was refused before it.
    expect(lookups).toEqual([[987_654], [V1_DELETED_MODEL]]);
  });

  it('a document without the declared field is accepted, without a lookup', async () => {
    const { tokenOf } = await setup();
    const v1 = await tokenOf(VIEWER_IDS.v1);
    const r = await call({
      token: v1,
      method: 'POST',
      path: '/picks',
      body: { data: { title: 'no workflow yet' } },
    });
    expect(r.status).toBe(201);
    expect(lookups).toEqual([]);
  });

  it('refuses before the trust gate: an untrusted viewer gets resource_not_owned, not not_eligible', async () => {
    const { tokenOf } = await setup();
    const newbie = await tokenOf(VIEWER_IDS.newbie);
    const refused = await call({
      token: newbie,
      method: 'POST',
      path: '/picks',
      body: pick(V2_OWN),
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual(refusedBody);
    // Control: without a declared field the same viewer reaches the trust gate.
    const gated = await call({ token: newbie, method: 'POST', path: '/picks', body: { data: {} } });
    expect(gated.status).toBe(403);
    expect(gated.body).toMatchObject({ code: 'not_eligible' });
  });

  it('a moderator writing is not exempt', async () => {
    const { tokenOf } = await setup();
    h.users.set(VIEWER_IDS.v3, { ...user('v3', true), isModerator: true });
    const mod = await tokenOf(VIEWER_IDS.v3);
    const r = await call({ token: mod, method: 'POST', path: '/picks', body: pick(V1_OWN) });
    expect(r.status).toBe(403);
    expect(r.body).toEqual(refusedBody);
  });

  it('marks and counters never touch data, so they work on a document holding any version', async () => {
    const { tokenOf } = await setup();
    const v1 = await tokenOf(VIEWER_IDS.v1);
    const v2 = await tokenOf(VIEWER_IDS.v2);
    expect(
      (await call({ token: v1, method: 'PUT', path: '/picks/k', body: pick(V1_OWN) })).status
    ).toBe(200);
    lookups = [];
    expect((await call({ token: v2, method: 'PUT', path: '/picks/k/marks/vote' })).status).toBe(
      200
    );
    expect(
      (await call({ token: v2, method: 'POST', path: '/picks/k/counters/views' })).status
    ).toBe(200);
    expect(lookups).toEqual([]);
  });

  it("[invariant guard] a collection that does not declare the rule stores another user's version unchecked", async () => {
    const { tokenOf } = await setup();
    const v1 = await tokenOf(VIEWER_IDS.v1);
    const r = await call({ token: v1, method: 'POST', path: '/plain', body: pick(V2_OWN) });
    expect(r.status).toBe(201);
    expect(lookups).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Shared-data moderation follows the per-app shadow/enforce flags
// ---------------------------------------------------------------------------

describe('shared-data moderation follows the per-app shadow / enforce flags', () => {
  const HITS_TABLE = 'appBlocksSharedDataHits';
  const SCANS_TABLE = 'appBlocksSharedDataScans';
  const BLOCK_ALERTS = [
    'app-blocks-shared-storage-legal-block',
    'app-blocks-shared-storage-content-block',
  ];
  const rowsOf = (table: string) =>
    h.ch.inserts.filter((i) => i.table === table).flatMap((i) => i.values) as Record<
      string,
      unknown
    >[];
  const eventNames = () =>
    loggingMock.logToAxiom.mock.calls.map((c) => String((c[0] as { name?: string }).name));
  const flushImmediates = async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const scanner = async () => {
    const m = await import('~/server/services/apps/shared-data-moderation');
    return { data: vi.mocked(m.scanSharedData), key: vi.mocked(m.scanCounterKey) };
  };

  async function setup(mode: 'off' | 'shadow' | 'enforce') {
    h.moderationMode = mode;
    h.ch.capture = true;
    const { A } = freshApps();
    const v1 = await mint({ app: A, uid: VIEWER_IDS.v1, scopes: contract.defaultScopes });
    loggingMock.logToAxiom.mockClear();
    h.isFlipt.mockClear();
    const s = await scanner();
    s.data.mockClear();
    s.key.mockClear();
    return { A, v1, ...s };
  }

  describe('SHADOW', () => {
    it('🔴 REGRESSION: a hit on a shared PUT does not refuse the write; it is recorded as shadow, unblocked, with no alert', async () => {
      const { A, v1 } = await setup('shadow');
      const r = await call({
        token: v1,
        method: 'PUT',
        path: '/posts/p1',
        body: { data: { t: 'contract-blocked-term' } },
      });
      expect(r.status).toBe(200);
      const stored = await call({ token: v1, method: 'GET', path: '/posts/p1' });
      expect(stored.status).toBe(200);
      expect(stored.body).toMatchObject({ data: { t: 'contract-blocked-term' } });

      await vi.waitFor(() => expect(rowsOf(HITS_TABLE).length).toBeGreaterThan(0));
      // The legacy surface's own row shape: shadow keeps the user text (the leaf, the matched term).
      expect(rowsOf(HITS_TABLE)).toEqual([
        expect.objectContaining({
          appBlockId: A.id,
          rowKey: 'p1',
          surface: 'update',
          mode: 'shadow',
          blocked: 0,
          category: 'audit_regex',
          matched: 'scanner-matched-text-zq81',
          leafText: JSON.stringify({ t: 'contract-blocked-term' }),
        }),
      ]);
      // One denominator row per scan: the data blob, and the app-chosen key.
      await vi.waitFor(() => expect(rowsOf(SCANS_TABLE)).toHaveLength(2));
      expect(rowsOf(SCANS_TABLE)).toEqual([
        expect.objectContaining({ surface: 'update', mode: 'shadow', blocked: 0 }),
        expect.objectContaining({ surface: 'update', mode: 'shadow', blocked: 0 }),
      ]);
      await flushImmediates();
      for (const alert of BLOCK_ALERTS) expect(eventNames()).not.toContain(alert);
    });

    it('🔴 REGRESSION: a hit on a create and on a counter-created key is recorded after the write, never refused', async () => {
      const { v1 } = await setup('shadow');
      const created = await call({
        token: v1,
        method: 'POST',
        path: '/posts',
        body: { data: { 'contract-blocked-term': 'in a key' } },
      });
      expect(created.status).toBe(201);
      const createdKey = (created.body as { key: string }).key;
      const counted = await call({
        token: v1,
        method: 'POST',
        path: '/plays/contract-blocked-term/counters/plays',
      });
      expect(counted.status).toBe(200);

      await vi.waitFor(() => expect(rowsOf(HITS_TABLE)).toHaveLength(2));
      expect(rowsOf(HITS_TABLE)).toEqual(
        expect.arrayContaining([
          // A create's row carries the key the store gave it, once it exists.
          expect.objectContaining({
            rowKey: createdKey,
            surface: 'append',
            mode: 'shadow',
            blocked: 0,
          }),
          expect.objectContaining({
            rowKey: 'contract-blocked-term',
            surface: 'counter',
            mode: 'shadow',
            blocked: 0,
          }),
        ])
      );
      await flushImmediates();
      for (const alert of BLOCK_ALERTS) expect(eventNames()).not.toContain(alert);
    });

    it('🔴 REGRESSION: a scanner outage does not refuse the write (no 503); it is only logged', async () => {
      const { v1 } = await setup('shadow');
      const r = await call({
        token: v1,
        method: 'PUT',
        path: '/posts/p1',
        body: { data: { t: 'contract-scanner-down' } },
      });
      expect(r.status).toBe(200);
      await vi.waitFor(() =>
        expect(eventNames()).toContain('app-blocks-shared-data-moderation-shadow-failed')
      );
      expect(rowsOf(HITS_TABLE)).toEqual([]);
    });

    it('the write does not wait for the scan — a scanner that never settles cannot hold it', async () => {
      const { v1, data } = await setup('shadow');
      data.mockImplementationOnce(() => new Promise<SharedTextScan>(() => undefined));
      try {
        const r = await call({ token: v1, method: 'PUT', path: '/posts/p1', body: { data: {} } });
        expect(r.status).toBe(200);
      } finally {
        // Drops the never-settling scanner if it went unused, back to the mock's own verdicts.
        data.mockReset();
      }
    }, 5_000);

    it('a write that fails in the store schedules no scan', async () => {
      const { A, v1, data, key } = await setup('shadow');
      const v2 = await mint({ app: A, uid: VIEWER_IDS.v2, scopes: contract.defaultScopes });
      expect(
        (await call({ token: v1, method: 'PUT', path: '/posts/owned', body: { data: {} } })).status
      ).toBe(200);
      await flushImmediates();
      data.mockClear();
      key.mockClear();
      // v2 is not the author: the store refuses, so nothing landed and nothing is scanned.
      const refused = await call({
        token: v2,
        method: 'PUT',
        path: '/posts/owned',
        body: { data: { t: 'contract-blocked-term' } },
      });
      expect(refused.status).toBe(403);
      await flushImmediates();
      expect(data).not.toHaveBeenCalled();
      expect(key).not.toHaveBeenCalled();
    });

    it('a create or a counter increment that fails in the store schedules no scan', async () => {
      const { v1, data, key } = await setup('shadow');
      h.store = {
        ...liveStore,
        create: async () => {
          throw new Error('store create failed');
        },
        increment: async () => {
          throw new Error('store increment failed');
        },
      } as DocStore;
      const created = await call({
        token: v1,
        method: 'POST',
        path: '/posts',
        body: { data: { t: 'contract-blocked-term' } },
      });
      expect(created.status).toBe(500);
      const counted = await call({
        token: v1,
        method: 'POST',
        path: '/plays/contract-blocked-term/counters/plays',
      });
      expect(counted.status).toBe(500);
      await flushImmediates();
      expect(data).not.toHaveBeenCalled();
      expect(key).not.toHaveBeenCalled();
    });

    it('INVARIANT GUARD: moderators keep their pattern-list exemption in shadow too', async () => {
      const { A, data, key } = await setup('shadow');
      h.users.set(VIEWER_IDS.v3, { ...user('v3', true), isModerator: true });
      const mod = await mint({ app: A, uid: VIEWER_IDS.v3, scopes: contract.defaultScopes });
      expect(
        (await call({ token: mod, method: 'PUT', path: '/posts/m', body: { data: {} } })).status
      ).toBe(200);
      await vi.waitFor(() => expect(key).toHaveBeenCalled());
      expect(data.mock.calls.at(-1)?.[1]).toEqual({ isModerator: true });
      expect(key.mock.calls.at(-1)?.[1]).toEqual({ isModerator: true });
    });
  });

  describe('OFF', () => {
    it('nothing is scanned or recorded, and a would-be hit is stored', async () => {
      const { v1, data, key } = await setup('off');
      const put = await call({
        token: v1,
        method: 'PUT',
        path: '/posts/p1',
        body: { data: { t: 'contract-blocked-term' } },
      });
      expect(put.status).toBe(200);
      const counted = await call({
        token: v1,
        method: 'POST',
        path: '/plays/contract-blocked-term/counters/plays',
      });
      expect(counted.status).toBe(200);
      await flushImmediates();
      expect(data).not.toHaveBeenCalled();
      expect(key).not.toHaveBeenCalled();
      expect(h.ch.inserts).toEqual([]);
      expect(eventNames()).not.toContain('app-blocks-shared-data-moderation-scan');
    });
  });

  describe('ENFORCE (unchanged)', () => {
    it('INVARIANT GUARD: a hit is refused with 422 content_rejected and raises the block alert', async () => {
      const { v1 } = await setup('enforce');
      const r = await call({
        token: v1,
        method: 'PUT',
        path: '/posts/p1',
        body: { data: { t: 'contract-blocked-term' } },
      });
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ code: 'content_rejected' });
      expect(eventNames()).toContain('app-blocks-shared-storage-content-block');
      expect((await call({ token: v1, method: 'GET', path: '/posts/p1' })).status).toBe(404);
    });

    it('INVARIANT GUARD: a scanner outage is refused with 503 moderation_unavailable', async () => {
      const { v1 } = await setup('enforce');
      const r = await call({
        token: v1,
        method: 'PUT',
        path: '/posts/p1',
        body: { data: { t: 'contract-scanner-down' } },
      });
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ code: 'moderation_unavailable' });
    });
  });

  it('the mode is resolved per APP: entity id = the app block id, no context', async () => {
    const { A, v1 } = await setup('shadow');
    await call({ token: v1, method: 'PUT', path: '/posts/p1', body: { data: {} } });
    expect(h.isFlipt).toHaveBeenCalledWith(SHADOW_FLAG, A.id, undefined);
    expect(h.isFlipt).toHaveBeenCalledWith(ENFORCE_FLAG, A.id, undefined);
  });
});
