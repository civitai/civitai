// Setup-order import: installs the env mock with the test RSA keypair BEFORE the block-token
// service and the middleware read it at module load.
import '~/__tests__/setup';
import { createHash, createHmac } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { Readable } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import promClient from 'prom-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { allowConnection } from '~/__tests__/network-guard';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as FliptClient from '~/server/flipt/client';
import type * as SessionClientModule from '~/server/auth/session-client';
import type * as Moderation from '~/server/services/apps/shared-data-moderation';
import type * as SubListingService from '~/server/services/blocks/app-sub-listing.service';
import type * as ImportGrants from '~/server/services/apps/storage-import-grant.service';
import type { SharedTextScan } from '~/server/services/apps/shared-data-moderation';
import type { DocStore } from '~/server/services/apps/doc-store';
import { createLuaRedis, type LuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import { createPgliteHarness, type Harness } from './doc-store.harness';

/**
 * App Storage PERMISSION HOOKS on the write path, end to end: a REAL signed block token → the REAL
 * `withBlockScope` → the REAL page handler → the REAL resolver → the REAL hook gate and runner
 * client (`doc-store-hook.ts`) → the REAL document store on an embedded Postgres with RLS. The
 * harness is the one `doc-store-api.contract.test.ts` uses (the same boundary mocks: the rows the
 * resolver reads, Redis with the Lua harness for the write budget, the session hub, the flags, the
 * moderation scanner, and here the stored hook sources and the import grant ledger).
 *
 * The runner is reached over real loopback HTTP, two ways:
 *   - a STUB runner (a node http server in this process) that speaks the signed contract and
 *     decides from a table of the fixture hooks, and can be made to fail in each way the write
 *     path must fail closed on;
 *   - the REAL runner (`apps/storage-hook-runner`: its Fastify app, worker pool and QuickJS
 *     sandbox), started in-process on an ephemeral port: the seam. The same matrix runs against
 *     both, so the stub's table cannot drift from what the real sandbox decides.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const RUNNER_SECRET = 'storage-hook-runner-test-secret-0123456789abcdef';
const OFFLINE_FLAG = 'app-blocks-storage-hook-runner-offline';
const PUBLISH_FLAG = 'app-blocks-storage-publish';
const UNCHANGED_FLAG = 'app-blocks-storage-unchanged-writes-free';
const LEVELS_FLAG = 'app-blocks-shared-doc-levels';

const h = vi.hoisted(() => ({
  store: undefined as unknown as DocStore,
  users: new Map<number, unknown>(),
  /** App block ids the runner-offline flag is on for; `'throw'` makes every Flipt call throw. */
  offline: new Set<string>() as Set<string> | 'throw',
  fliptCalls: [] as { flag: string; entityId?: string; context?: unknown }[],
  /** Other `isFlipt` flags a test switches on (publish, unchanged writes). */
  flagsOn: new Set<string>(),
  /** The content-levels flag as `readFliptBoolean` reads it: off unless a case turns it on. */
  levels: false,
}));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const real = await importOriginal<typeof FliptClient>();
  return {
    ...real,
    isFlipt: async (flag: string, entityId?: string, context?: unknown) => {
      h.fliptCalls.push({ flag, entityId, context });
      if (flag === OFFLINE_FLAG) {
        if (h.offline === 'throw') throw new Error('flipt unreachable');
        return entityId !== undefined && h.offline.has(entityId);
      }
      // Shared-data moderation: enforce, so a scan that runs is observable.
      if (flag === 'app-blocks-shared-data-moderation-enforce') return true;
      return h.flagsOn.has(flag);
    },
    readFliptBoolean: async (flag: string, ...rest: unknown[]) => {
      if (flag === LEVELS_FLAG) return h.levels;
      return (real.readFliptBoolean as (...a: unknown[]) => Promise<boolean | undefined>)(
        flag,
        ...rest
      );
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
vi.mock('~/server/services/blocks/app-sub-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubListingService>()),
  syncSubListingForSharedRow: vi.fn(async () => undefined),
}));
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
// The per-source import ledger has its own suite (and the contract file runs it for real): here
// every declared import is granted, so a `?from=` call reaches the source's collections.
vi.mock('~/server/services/apps/storage-import-grant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImportGrants>()),
  getStorageImportGrant: vi.fn(async () => ({ collections: ['notes'], access: 'readwrite' })),
  importGrantCovers: vi.fn(() => true),
}));

import { BlockTokenService } from '~/server/services/block-token.service';
import { createDocStore } from '~/server/services/apps/doc-store';
import { DEFAULT_DOC_STORE_LIMITS } from '~/server/services/apps/doc-store.types';
import { DOC_STORE_SHARED_WRITE_BUDGET } from '~/server/utils/shared-storage-rate-limit';
import { OnboardingSteps } from '~/server/common/enums';
import { scanSharedData } from '~/server/services/apps/shared-data-moderation';
import {
  HOOK_RUNNER_BACKSTOP_MS,
  hookClientTimeoutMs,
  hookRunnerConfig,
  normalizeHookRunnerSecret,
  resetHookSourceCacheForTests,
} from '~/server/services/apps/doc-store-hook';
import storageRoute from '~/pages/api/v1/blocks/storage/[[...path]]';

// ---------------------------------------------------------------------------
// The fixture hooks: real ES modules (the real runner evaluates them) and the same rule as a
// table (the stub runner answers from it). Every refusal names its op, so no single hardcoded
// reason can pass two rows.
// ---------------------------------------------------------------------------

const CARDS_SRC = `export default function check(input) {
  const { op, before, after, tally } = input;
  if (after && typeof after.title === 'string' && after.title.startsWith('DENY'))
    return { allow: false, reason: op + ': title not allowed' };
  if (before && before.locked === true) return { allow: false, reason: op + ': card is locked' };
  if (tally && tally.$inc && Object.values(tally.$inc)[0] > 1)
    return { allow: false, reason: op + ': one at a time' };
  return { allow: true };
}
`;
const P_NOTES_SRC = `export default function check({ after }) {
  if (after && typeof after.title === 'string' && after.title.startsWith('P-DENY'))
    return { allow: false, reason: 'refused by the source app' };
  return { allow: true };
}
`;
const F_NOTES_SRC = `export default function check({ after }) {
  if (after && typeof after.title === 'string' && after.title.startsWith('F-DENY'))
    return { allow: false, reason: 'refused by the importing app' };
  return { allow: true };
}
`;
const BOOM_SRC = `export default function check() {
  throw new Error('the hook is broken');
}
`;

type HookIn = {
  op: string;
  collection: string;
  key: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  doc: Record<string, unknown> | null;
  tally: { $inc: Record<string, number> } | { $mark: string } | { $unmark: string } | null;
  viewer: { userId: number };
  app: { blockId: string };
  from: string | null;
  parent?: string | null;
};
type HookOut = { allow: true } | { allow: false; reason: string } | { throws: true };

const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const CARDS_SHA = sha(CARDS_SRC);
const P_NOTES_SHA = sha(P_NOTES_SRC);
const F_NOTES_SHA = sha(F_NOTES_SRC);
const BOOM_SHA = sha(BOOM_SRC);
const SOURCES: Record<string, string> = {
  [CARDS_SHA]: CARDS_SRC,
  [P_NOTES_SHA]: P_NOTES_SRC,
  [F_NOTES_SHA]: F_NOTES_SRC,
  [BOOM_SHA]: BOOM_SRC,
};
const DECIDE: Record<string, (i: HookIn) => HookOut> = {
  [CARDS_SHA]: ({ op, before, after, tally }) => {
    if (after && typeof after.title === 'string' && after.title.startsWith('DENY'))
      return { allow: false, reason: `${op}: title not allowed` };
    if (before && before.locked === true) return { allow: false, reason: `${op}: card is locked` };
    if (tally && '$inc' in tally && Object.values(tally.$inc)[0] > 1)
      return { allow: false, reason: `${op}: one at a time` };
    return { allow: true };
  },
  [P_NOTES_SHA]: ({ after }) =>
    after && typeof after.title === 'string' && after.title.startsWith('P-DENY')
      ? { allow: false, reason: 'refused by the source app' }
      : { allow: true },
  [F_NOTES_SHA]: ({ after }) =>
    after && typeof after.title === 'string' && after.title.startsWith('F-DENY')
      ? { allow: false, reason: 'refused by the importing app' }
      : { allow: true },
  [BOOM_SHA]: () => ({ throws: true }),
};

// One file per hook: a manifest that pins one file with two digests does not parse.
const hookOf = (sha256: string) => ({
  file: `hooks/${sha256.slice(0, 12)}.js`,
  sha256,
  timeoutMs: 200,
});
const CARD_SCHEMA = {
  type: 'object',
  required: ['title'],
  additionalProperties: false,
  properties: { title: { type: 'string', maxLength: 40 }, locked: { type: 'boolean' } },
};

const SCOPES = ['apps:storage', 'apps:storage:publish'];

/**
 * The shared-write burst, and one write past it: a run of OVER shared writes meets exactly one 429
 * when every write spends its token, and none when the refused ones are refunded.
 */
const BURST = DOC_STORE_SHARED_WRITE_BUDGET.burst.capacity;
const OVER = BURST + 1;
const CONSUMER_SCOPES = ['apps:storage', 'apps:storage:import'];

/** P, the app with the hooks. */
const P_MANIFEST = {
  scopes: SCOPES,
  storage: {
    collections: {
      cards: {
        visibility: 'shared',
        write: 'own',
        counters: ['likes'],
        marks: ['star'],
        schema: CARD_SCHEMA,
        hook: hookOf(CARDS_SHA),
      },
      notes: { visibility: 'private', hook: hookOf(P_NOTES_SHA) },
      boom: { visibility: 'shared', write: 'own', hook: hookOf(BOOM_SHA) },
      plain: { visibility: 'shared', write: 'own', marks: ['star'] },
    },
  },
};
/** F, an app importing P's `notes`, with a hooked `notes` of its own. */
const fManifest = (pBlockId: string) => ({
  scopes: CONSUMER_SCOPES,
  storage: {
    collections: { notes: { visibility: 'private', hook: hookOf(F_NOTES_SHA) } },
    imports: [{ from: pBlockId, collections: ['notes'], access: 'readwrite' }],
  },
});

// ---------------------------------------------------------------------------
// Fixtures (the contract harness's)
// ---------------------------------------------------------------------------

type AppRow = { id: string; appId: string; blockId: string; status: string; manifest: unknown };
let apps: AppRow[] = [];
let seq = 0;

function appRow(label: string, manifest: unknown): AppRow {
  const row = {
    id: `apb_hook${label}${seq}`,
    appId: `appblk-hook${label}${seq}`,
    blockId: `hook-${label}-${seq}`,
    status: 'approved',
    manifest,
  };
  apps.push(row);
  return row;
}
function freshApps() {
  seq += 1;
  const P = appRow('p', P_MANIFEST);
  const F = appRow('f', fManifest(P.blockId));
  return { P, F };
}

const V1 = 730_911;
const V2 = 730_918;
function user(id: number) {
  return {
    id,
    username: `hooks_${id}`,
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

/** Reads of `app_storage_hook_sources`, by sha256 (every read, replica and primary). */
let sourceReads: Record<string, number> = {};
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
  dbMock.dbRead.user.findMany.mockResolvedValue([]);
  dbMock.dbRead.account.count.mockResolvedValue(0);
  const sources = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!strings.join('?').includes('app_storage_hook_sources')) return [];
    const key = String(values[0]);
    sourceReads[key] = (sourceReads[key] ?? 0) + 1;
    return SOURCES[key] ? [{ source: SOURCES[key] }] : [];
  };
  dbMock.dbRead.$queryRaw.mockImplementation(sources);
  dbMock.dbWrite.$queryRaw.mockImplementation(sources);
}

// The route's JSON, read field by field in the assertions below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { status: number; body: any; headers: Record<string, unknown> };

async function mint(
  app: AppRow,
  uid: number,
  scopes = SCOPES,
  review?: { publishRequestId: string }
): Promise<string> {
  const { token } = await BlockTokenService.sign({
    userId: uid,
    blockId: app.blockId,
    appId: app.appId,
    // A review preview's token carries its publish request's id here.
    appBlockId: review ? review.publishRequestId : app.id,
    ...(review ? { reviewRunForReal: true } : {}),
    blockInstanceId: `bki_${app.id}`,
    scopes,
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
  query?: Record<string, string>;
  body?: unknown;
}): Promise<Reply> {
  const segments = opts.path.split('/').filter(Boolean);
  const text = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const req = Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {
    method: opts.method,
    url: `/api/v1/blocks/storage${opts.path}`,
    query: { ...(opts.query ?? {}), ...(segments.length ? { path: segments } : {}) },
    headers: { authorization: `Bearer ${opts.token}` },
    socket: { remoteAddress: '198.51.100.9' },
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
  return { status, body, headers };
}

/** `civitai_app_block_storage_hook_calls_total{outcome}` now. */
async function hookCalls(outcome: string): Promise<number> {
  const metric = promClient.register.getSingleMetric('civitai_app_block_storage_hook_calls_total');
  if (!metric) return 0;
  const v = (await metric.get()).values.find((x) => x.labels.outcome === outcome);
  return Number(v?.value ?? 0);
}

// ---------------------------------------------------------------------------
// The runners
// ---------------------------------------------------------------------------

type Seen = { sha256: string; input: HookIn; appId: string };
type Runner = {
  kind: 'stub' | 'real';
  url: string;
  /** Every request that reached the runner, in order. */
  seen: Seen[];
  close(): Promise<void>;
};

/**
 * How the stub answers. Every mode after `badsig` is SIGNED CORRECTLY and wrong in exactly one
 * other way, so only the client's own binding and result checks can refuse it.
 */
type StubMode =
  | 'ok'
  | 'blackhole'
  | '500'
  | 'badsig'
  | 'wrongreq'
  | 'stalepast'
  | 'stalefuture'
  | 'skewok'
  | 'nonjson'
  | '4xx'
  | 'malformedresult'
  | 'unknowncause'
  | 'emptyreason'
  | 'longreason'
  | 'allowextra';
const stub = {
  mode: 'ok' as StubMode,
  /** Awaited before the stub answers (a write racing the hook). */
  beforeAnswer: null as null | ((seen: Seen) => Promise<void>),
};

const hmac = (secret: string, body: string) =>
  createHmac('sha256', secret).update(body).digest('hex');

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startStubRunner(): Promise<Runner> {
  const seen: Seen[] = [];
  const held: ServerResponse[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const reqDigest = createHash('sha256').update(raw).digest('hex');
      const send = (status: number, body: unknown, secret = RUNNER_SECRET) => {
        const text = JSON.stringify(body);
        res.writeHead(status, {
          'content-type': 'application/json',
          'x-storage-hook-sig': hmac(secret, text),
        });
        res.end(text);
      };
      const ts = Math.floor(Date.now() / 1000);
      if (req.headers['x-storage-hook-sig'] !== hmac(RUNNER_SECRET, raw)) {
        return send(401, { ts, req: reqDigest, error: { code: 'bad_signature', message: '' } });
      }
      const parsed = JSON.parse(raw) as { sha256: string; input: HookIn; appId: string };
      const entry: Seen = { sha256: parsed.sha256, input: parsed.input, appId: parsed.appId };
      seen.push(entry);
      if (stub.beforeAnswer) await stub.beforeAnswer(entry);
      if (stub.mode === 'blackhole') {
        held.push(res);
        return;
      }
      if (stub.mode === '500') {
        return send(500, {
          ts,
          req: reqDigest,
          error: { code: 'worker_terminated', message: 'backstop' },
        });
      }
      const out = DECIDE[parsed.sha256]?.(parsed.input);
      const result = !out
        ? null
        : 'throws' in out
        ? { allow: false, cause: 'error', detail: 'Error: the hook is broken' }
        : out.allow
        ? { allow: true }
        : { allow: false, cause: 'denied', reason: out.reason };
      if (!result) {
        return send(400, { ts, req: reqDigest, error: { code: 'bad_request', message: '' } });
      }
      const body: Record<string, unknown> = { ts, req: reqDigest, elapsedMs: 0.2, result };
      switch (stub.mode) {
        case 'wrongreq':
          body.req = createHash('sha256').update(`${raw} `).digest('hex');
          break;
        // ±62, not ±61: the client reads its clock up to a second after the stub, so 61 could
        // land on exactly 60 (inside the window) and pass by timing.
        case 'stalepast':
          body.ts = ts - 62;
          break;
        case 'stalefuture':
          body.ts = ts + 62;
          break;
        case 'skewok':
          body.ts = ts - 55;
          break;
        case 'nonjson': {
          const text = 'allow';
          res.writeHead(200, { 'x-storage-hook-sig': hmac(RUNNER_SECRET, text) });
          return res.end(text);
        }
        case '4xx':
          return send(400, { ts, req: reqDigest, error: { code: 'bad_request', message: '' } });
        case 'malformedresult':
          body.result = 'allow';
          break;
        case 'unknowncause':
          body.result = { allow: false, cause: 'tired' };
          break;
        case 'emptyreason':
          body.result = { allow: false, cause: 'denied', reason: '   ' };
          break;
        case 'longreason':
          body.result = { allow: false, cause: 'denied', reason: 'x'.repeat(201) };
          break;
        case 'allowextra':
          body.result = { allow: true, also: 1 };
          break;
      }
      return send(200, body, stub.mode === 'badsig' ? `${RUNNER_SECRET}-wrong` : RUNNER_SECRET);
    });
  });
  const url = await listen(server);
  return {
    kind: 'stub',
    url,
    seen,
    close: async () => {
      for (const r of held.splice(0)) r.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// The real runner's sources, imported by a computed path: they are a separate package with its own
// tsconfig (explicit `.ts` imports, erasable syntax), so the app's typecheck must not follow them.
const RUNNER_SRC = path.resolve(__dirname, '../../../../../apps/storage-hook-runner/src');
type RunnerPool = {
  run: (args: {
    appId: string;
    source: string;
    inputJson: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  close: () => Promise<void>;
};
type RunnerModules = {
  buildApp: (deps: { secret: string; mode: 'check'; pool: unknown; metrics: unknown }) => {
    listen: (o: { port: number; host: string }) => Promise<string>;
    close: () => Promise<void>;
  };
  HookPool: { start: (o: { size: number }) => Promise<RunnerPool> };
  createMetrics: () => unknown;
  BACKSTOP_MS: number;
  normalizeRunnerSecret: (raw: string | undefined) => string;
};
async function importRunner(): Promise<RunnerModules> {
  const load = (file: string) => import(/* @vite-ignore */ path.join(RUNNER_SRC, file));
  const [app, pool, metrics, limits, config] = await Promise.all([
    load('app.ts'),
    load('pool.ts'),
    load('metrics.ts'),
    load('limits.ts'),
    load('config.ts'),
  ]);
  return {
    buildApp: app.buildApp,
    HookPool: pool.HookPool,
    createMetrics: metrics.createMetrics,
    BACKSTOP_MS: limits.BACKSTOP_MS,
    normalizeRunnerSecret: config.normalizeRunnerSecret,
  };
}

async function startRealRunner(): Promise<Runner> {
  const m = await importRunner();
  const pool = await m.HookPool.start({ size: 1 });
  const seen: Seen[] = [];
  // Every evaluation the runner's route handed to its pool (after it verified the signature, the
  // body and the sha), recorded and then run for real.
  const run = pool.run.bind(pool);
  pool.run = (args) => {
    seen.push({ sha256: sha(args.source), input: JSON.parse(args.inputJson), appId: args.appId });
    return run(args);
  };
  const app = m.buildApp({
    secret: RUNNER_SECRET,
    mode: 'check',
    pool,
    metrics: m.createMetrics(),
  });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    kind: 'real',
    url,
    seen,
    close: async () => {
      await app.close();
      await pool.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let harness: Harness;
let liveStore: DocStore;

beforeAll(async () => {
  harness = await createPgliteHarness({ rls: true, docLevels: true });
  liveStore = createDocStore({ db: harness.db, limits: DEFAULT_DOC_STORE_LIMITS });
  h.store = liveStore;
});
afterAll(async () => {
  await harness?.close();
});

beforeEach(() => {
  apps = [];
  sourceReads = {};
  h.offline = new Set();
  h.fliptCalls = [];
  h.flagsOn = new Set();
  h.levels = false;
  h.users.clear();
  for (const id of [V1, V2]) h.users.set(id, user(id));
  stub.mode = 'ok';
  stub.beforeAnswer = null;
  installRedis();
  installDb();
  resetHookSourceCacheForTests();
  vi.mocked(scanSharedData).mockClear();
  h.store = liveStore;
});
afterEach(() => {
  expect(lua.errors).toEqual([]);
});

function useRunner(runner: () => Runner) {
  beforeEach(() => {
    setEnv({ STORAGE_HOOK_RUNNER_URL: runner().url, STORAGE_HOOK_RUNNER_SECRET: RUNNER_SECRET });
    runner().seen.length = 0;
  });
}

// ---------------------------------------------------------------------------
// The matrix: 6 ops × {allow, deny}, against the stub AND the real runner
// ---------------------------------------------------------------------------

describe.each(['stub', 'real'] as const)('every write op calls the hook (%s runner)', (kind) => {
  let runner: Runner;
  beforeAll(async () => {
    runner = kind === 'stub' ? await startStubRunner() : await startRealRunner();
  });
  afterAll(async () => {
    await runner?.close();
  });
  useRunner(() => runner);

  /** An unlocked card U, and a locked card L that carries the viewer's `star`. */
  async function cards(token: string) {
    const u = await call({ token, method: 'POST', path: '/cards', body: { data: { title: 'U' } } });
    const l = await call({ token, method: 'POST', path: '/cards', body: { data: { title: 'L' } } });
    expect([u.status, l.status]).toEqual([201, 201]);
    const L = l.body.key as string;
    expect((await call({ token, method: 'PUT', path: `/cards/${L}/marks/star` })).status).toBe(200);
    const locked = await call({
      token,
      method: 'PUT',
      path: `/cards/${L}`,
      body: { data: { title: 'L', locked: true } },
    });
    expect(locked.status).toBe(200);
    runner.seen.length = 0;
    return { U: u.body.key as string, L };
  }
  const read = async (token: string, key: string) =>
    (await call({ token, method: 'GET', path: `/cards/${key}` })).body;

  type Row = {
    op: string;
    run: (token: string, k: { U: string; L: string }) => Promise<Reply>;
    allowStatus: number;
  };
  const ROWS: Row[] = [
    {
      op: 'create',
      run: (token, _k) =>
        call({ token, method: 'POST', path: '/cards', body: { data: { title: 'fresh' } } }),
      allowStatus: 201,
    },
    {
      op: 'put',
      run: (token, k) =>
        call({ token, method: 'PUT', path: `/cards/${k.U}`, body: { data: { title: 'U2' } } }),
      allowStatus: 200,
    },
    {
      op: 'delete',
      run: (token, k) => call({ token, method: 'DELETE', path: `/cards/${k.U}` }),
      allowStatus: 200,
    },
    {
      op: 'increment',
      run: (token, k) =>
        call({ token, method: 'POST', path: `/cards/${k.U}/counters/likes`, body: { by: 1 } }),
      allowStatus: 200,
    },
    {
      op: 'mark',
      run: (token, k) => call({ token, method: 'PUT', path: `/cards/${k.U}/marks/star` }),
      allowStatus: 200,
    },
    {
      op: 'unmark',
      run: async (token, k) => {
        await call({ token, method: 'PUT', path: `/cards/${k.U}/marks/star` });
        runner.seen.length = 0;
        return call({ token, method: 'DELETE', path: `/cards/${k.U}/marks/star` });
      },
      allowStatus: 200,
    },
  ];
  /** The denied twin of each row: the same op on the LOCKED card (create: a refused title). */
  const deny = (row: Row): Row => ({
    ...row,
    run: (token, k) =>
      row.op === 'create'
        ? call({ token, method: 'POST', path: '/cards', body: { data: { title: 'DENY me' } } })
        : row.op === 'unmark'
        ? call({ token, method: 'DELETE', path: `/cards/${k.L}/marks/star` })
        : row.run(token, { U: k.L, L: k.L }),
  });

  it.each(ROWS)('$op: allowed by the hook, the write lands', async (row) => {
    const { P } = freshApps();
    const token = await mint(P, V1);
    const k = await cards(token);
    const r = await row.run(token, k);
    expect(r.status, JSON.stringify(r.body)).toBe(row.allowStatus);
    // Exactly one hook call, for this op, on this app's cards hook.
    expect(runner.seen.map((s) => [s.input.op, s.sha256, s.appId])).toEqual([
      [row.op, CARDS_SHA, P.blockId],
    ]);
    const input = runner.seen[0].input;
    expect(input.viewer).toEqual({ userId: V1 });
    expect(input.from).toBeNull();
    if (row.op === 'create') expect(input.key).toBe(r.body.key);
    else expect(input.key).toBe(k.U);
  });

  // The hook's `tally` input is the storage API's update operator, the SAME whichever route carried
  // the write: the document PATCH or the deprecated per-tally alias. A document write has none.
  const TALLY_ROUTES: [string, string, (k: string) => [string, string, unknown], unknown][] = [
    [
      'increment',
      'POST …/counters/likes',
      (k) => ['POST', `/cards/${k}/counters/likes`, { by: 1 }],
      { $inc: { likes: 1 } },
    ],
    [
      'increment',
      'PATCH $inc',
      (k) => ['PATCH', `/cards/${k}`, { $inc: { likes: 1 } }],
      { $inc: { likes: 1 } },
    ],
    [
      'mark',
      'PUT …/marks/star',
      (k) => ['PUT', `/cards/${k}/marks/star`, undefined],
      { $mark: 'star' },
    ],
    ['mark', 'PATCH $mark', (k) => ['PATCH', `/cards/${k}`, { $mark: 'star' }], { $mark: 'star' }],
    [
      'unmark',
      'DELETE …/marks/star',
      (k) => ['DELETE', `/cards/${k}/marks/star`, undefined],
      { $unmark: 'star' },
    ],
    [
      'unmark',
      'PATCH $unmark',
      (k) => ['PATCH', `/cards/${k}`, { $unmark: 'star' }],
      { $unmark: 'star' },
    ],
  ];
  it.each(TALLY_ROUTES)(
    '%s via %s: the hook is shown the update operator',
    async (op, _route, request, expected) => {
      const { P } = freshApps();
      const token = await mint(P, V1);
      const k = await cards(token);
      if (op === 'unmark') {
        await call({ token, method: 'PUT', path: `/cards/${k.U}/marks/star` });
        runner.seen.length = 0;
      }
      const [method, p, body] = request(k.U);
      const r = await call({ token, method, path: p, body });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(runner.seen.map((x) => x.input.op)).toEqual([op]);
      expect(runner.seen[0].input.tally).toEqual(expected);
    }
  );

  it('a document write is shown no tally', async () => {
    const { P } = freshApps();
    const token = await mint(P, V1);
    const k = await cards(token);
    const r = await call({
      token,
      method: 'PUT',
      path: `/cards/${k.U}`,
      body: { data: { title: 'u' } },
    });
    expect(r.status).toBe(200);
    expect(runner.seen.map((x) => [x.input.op, x.input.tally])).toEqual([['put', null]]);
  });

  it('PATCH $inc by 2 is decided from the operator: refused "one at a time", the counter unchanged', async () => {
    const { P } = freshApps();
    const token = await mint(P, V1);
    const k = await cards(token);
    const r = await call({
      token,
      method: 'PATCH',
      path: `/cards/${k.U}`,
      body: { $inc: { likes: 2 } },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body).toMatchObject({ code: 'hook_rejected', message: 'increment: one at a time' });
    // Positive control: by 1 is allowed by the same rule.
    const one = await call({
      token,
      method: 'PATCH',
      path: `/cards/${k.U}`,
      body: { $inc: { likes: 1 } },
    });
    expect(one.status).toBe(200);
    expect((await read(token, k.U)).counters).toEqual({ likes: 1 });
  });

  it.each(ROWS.map(deny))(
    '$op: refused by the hook, 403 hook_rejected, nothing changes',
    async (row) => {
      const { P } = freshApps();
      const token = await mint(P, V1);
      const k = await cards(token);
      const before = await read(token, k.L);
      const listBefore = (await call({ token, method: 'GET', path: '/cards' })).body.items.length;
      const [denied0, allow0] = [await hookCalls('denied'), await hookCalls('allow')];
      const r = await row.run(token, k);
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect([(await hookCalls('denied')) - denied0, (await hookCalls('allow')) - allow0]).toEqual([
        1, 0,
      ]);
      expect(r.body).toMatchObject({
        code: 'hook_rejected',
        message: row.op === 'create' ? 'create: title not allowed' : `${row.op}: card is locked`,
        details: { collection: 'cards', cause: 'denied' },
      });
      expect(runner.seen.map((s) => s.input.op)).toEqual([row.op]);
      // Nothing changed: the locked card's version, counters and marks, and the number of cards.
      expect(await read(token, k.L)).toEqual(before);
      expect((await call({ token, method: 'GET', path: '/cards' })).body.items.length).toBe(
        listBefore
      );
    }
  );

  it('a denied create or put spends no moderation scan', async () => {
    const { P } = freshApps();
    const token = await mint(P, V1);
    const r = await call({
      token,
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'DENY scan' } },
    });
    expect(r.status).toBe(403);
    expect(vi.mocked(scanSharedData)).not.toHaveBeenCalled();
    // Positive control: an allowed create is scanned.
    const ok = await call({
      token,
      method: 'POST',
      path: '/cards',
      body: { data: { title: 's' } },
    });
    expect(ok.status).toBe(201);
    expect(vi.mocked(scanSharedData)).toHaveBeenCalledTimes(1);
  });

  it('a hook that fails is the author fault: 403 hook_rejected with a generic reason, refunded', async () => {
    const { P } = freshApps();
    const token = await mint(P, V1);
    for (let i = 0; i < OVER; i++) {
      const r = await call({ token, method: 'POST', path: '/boom', body: { data: { n: i } } });
      expect(r.status, `write ${i + 1}: ${JSON.stringify(r.body)}`).toBe(403);
      expect(r.body).toMatchObject({
        code: 'hook_rejected',
        message: "this write could not be checked: the app's permission hook failed",
        details: { collection: 'boom', cause: 'error' },
      });
    }
    expect(runner.seen).toHaveLength(OVER);
  });

  it('the schema runs first: a schema-invalid write never reaches the hook, a valid denied one does', async () => {
    const { P } = freshApps();
    const token = await mint(P, V1);
    const invalid = await call({
      token,
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'DENY x', extra: 1 } },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('schema_violation');
    expect(runner.seen).toHaveLength(0);
    const denied = await call({
      token,
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'DENY x' } },
    });
    expect(denied.status).toBe(403);
    expect(runner.seen).toHaveLength(1);
  });

  it('the report mark never calls the hook, even on a card the hook refuses everything on', async () => {
    const { P } = freshApps();
    const token = await mint(P, V1);
    const k = await cards(token);
    const r = await call({ token, method: 'PUT', path: `/cards/${k.L}/marks/report` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ marked: true });
    expect(runner.seen).toHaveLength(0);
    // Positive control: a declared mark on the same card does call it, and is refused.
    const star = await call({ token, method: 'PUT', path: `/cards/${k.L}/marks/star` });
    expect(star.status).toBe(403);
    expect(runner.seen).toHaveLength(1);
  });

  it("?from=P runs P's hook (told the importer), and F's own hook is never consulted", async () => {
    const { P, F } = freshApps();
    const viaF = await mint(F, V1, CONSUMER_SCOPES);
    const denied = await call({
      token: viaF,
      method: 'PUT',
      path: '/notes/n1',
      query: { from: P.blockId },
      body: { data: { title: 'P-DENY one' } },
    });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body).toMatchObject({
      code: 'hook_rejected',
      message: 'refused by the source app',
    });
    // F's hook would refuse this title; through the import it is P's call, and P allows it.
    const allowed = await call({
      token: viaF,
      method: 'PUT',
      path: '/notes/n2',
      query: { from: P.blockId },
      body: { data: { title: 'F-DENY two' } },
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(runner.seen.map((s) => [s.sha256, s.appId, s.input.app.blockId, s.input.from])).toEqual([
      [P_NOTES_SHA, P.blockId, P.blockId, F.blockId],
      [P_NOTES_SHA, P.blockId, P.blockId, F.blockId],
    ]);
    // F's hook source: never read, never sent.
    expect(sourceReads[F_NOTES_SHA] ?? 0).toBe(0);
    expect(runner.seen.filter((s) => s.sha256 === F_NOTES_SHA)).toHaveLength(0);
    // Positive control: F's own notes write does run F's hook.
    const own = await call({
      token: viaF,
      method: 'PUT',
      path: '/notes/n3',
      body: { data: { title: 'F-DENY three' } },
    });
    expect(own.status).toBe(403);
    expect(own.body.message).toBe('refused by the importing app');
    expect(sourceReads[F_NOTES_SHA]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fail closed (stub runner)
// ---------------------------------------------------------------------------

describe('fail closed: the runner cannot answer → 503 hook_unavailable, nothing stored, refunded', () => {
  let runner: Runner;
  beforeAll(async () => {
    runner = await startStubRunner();
  });
  afterAll(async () => {
    await runner?.close();
  });
  useRunner(() => runner);

  async function refusedUrl(): Promise<string> {
    const s = createServer();
    const url = await listen(s);
    await new Promise<void>((resolve) => s.close(() => resolve()));
    const port = Number(new URL(url).port);
    allowConnection('127.0.0.1', port);
    return url;
  }

  let shortTimeouts: { mockRestore(): void } | undefined;
  afterEach(() => {
    shortTimeouts?.mockRestore();
    shortTimeouts = undefined;
  });

  const MODES: [string, () => Promise<void>][] = [
    [
      'refused (nothing listening)',
      async () =>
        setEnv({
          STORAGE_HOOK_RUNNER_URL: await refusedUrl(),
          STORAGE_HOOK_RUNNER_SECRET: RUNNER_SECRET,
        }),
    ],
    [
      'black-holed (never answers)',
      async () => {
        stub.mode = 'blackhole';
        // The client still times out; it just does so in 100 ms instead of its real budget.
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        shortTimeouts = vi
          .spyOn(AbortSignal, 'timeout')
          .mockImplementation((ms) => timeout(Math.min(ms, 100)));
      },
    ],
    ['a runner 500 (a backstop kill)', async () => void (stub.mode = '500')],
    ['a response with a bad signature', async () => void (stub.mode = 'badsig')],
    // Signed correctly, but bound to ANOTHER request: its `req` is not this body's sha256.
    [
      'a response for another request (wrong req digest)',
      async () => void (stub.mode = 'wrongreq'),
    ],
    // Signed correctly, `ts` just outside the ±60 s window, each way.
    ['a stale response (ts 62 s in the past)', async () => void (stub.mode = 'stalepast')],
    ['a stale response (ts 62 s in the future)', async () => void (stub.mode = 'stalefuture')],
    ['a signed 200 whose body is not JSON', async () => void (stub.mode = 'nonjson')],
    ['a signed 4xx', async () => void (stub.mode = '4xx')],
    ['a result that is not an object', async () => void (stub.mode = 'malformedresult')],
    ['a refusal with an unknown cause', async () => void (stub.mode = 'unknowncause')],
    ['a deny whose reason is blank', async () => void (stub.mode = 'emptyreason')],
    ['a deny whose reason is over 200 code points', async () => void (stub.mode = 'longreason')],
    ['an allow carrying extra fields', async () => void (stub.mode = 'allowextra')],
    ['the runner not configured', async () => setEnv({ STORAGE_HOOK_RUNNER_URL: '' })],
  ];

  it('positive control: with the runner up, OVER allowed shared creates meet exactly one 429 (the burst)', async () => {
    expect(BURST).toBeGreaterThan(1);
    const { P } = freshApps();
    const token = await mint(P, V1);
    const statuses: number[] = [];
    for (let i = 0; i < OVER; i++) {
      statuses.push(
        (await call({ token, method: 'POST', path: '/cards', body: { data: { title: `c${i}` } } }))
          .status
      );
    }
    expect(statuses).toEqual([...Array(BURST).fill(201), 429]);
  });

  it.each(MODES)(
    '%s: OVER shared creates, every one 503 with Retry-After 5, no 429, none stored',
    async (_label, arrange) => {
      await arrange();
      const { P } = freshApps();
      const token = await mint(P, V1);
      const unavailable0 = await hookCalls('unavailable');
      for (let i = 0; i < OVER; i++) {
        const r = await call({
          token,
          method: 'POST',
          path: '/cards',
          body: { data: { title: `c${i}` } },
        });
        expect(r.status, `write ${i + 1}: ${JSON.stringify(r.body)}`).toBe(503);
        expect(r.body).toMatchObject({
          code: 'hook_unavailable',
          details: { collection: 'cards', retryAfter: 5 },
        });
        expect(r.headers['retry-after']).toBe('5');
      }
      expect((await hookCalls('unavailable')) - unavailable0).toBe(OVER);
      shortTimeouts?.mockRestore();
      stub.mode = 'ok';
      setEnv({ STORAGE_HOOK_RUNNER_URL: runner.url });
      expect((await call({ token, method: 'GET', path: '/cards' })).body.items).toEqual([]);
      // The budget came back too: the next write lands.
      const after = await call({
        token,
        method: 'POST',
        path: '/cards',
        body: { data: { title: 'ok' } },
      });
      expect(after.status).toBe(201);
    }
  );

  // 🔴 SEAM: both sides normalise the shared secret by ONE rule, so a value that verifies on one
  // side verifies on the other. Pinned as a relationship over the same inputs, not per side.
  it('the caller and the runner normalise the secret identically', async () => {
    const { normalizeRunnerSecret } = await importRunner();
    const inputs = [
      RUNNER_SECRET,
      `${RUNNER_SECRET}\n`,
      `${RUNNER_SECRET}\r\n`,
      `  ${RUNNER_SECRET}\t`,
      `\n${RUNNER_SECRET} `,
      '',
      undefined,
    ];
    expect(inputs.map(normalizeHookRunnerSecret)).toEqual(inputs.map(normalizeRunnerSecret));
    expect(normalizeHookRunnerSecret(`${RUNNER_SECRET}\n`)).toBe(RUNNER_SECRET);
  });

  it('a caller secret with a trailing newline still signs and verifies: the write is decided', async () => {
    setEnv({
      STORAGE_HOOK_RUNNER_URL: runner.url,
      STORAGE_HOOK_RUNNER_SECRET: `${RUNNER_SECRET}\n`,
    });
    expect(hookRunnerConfig()?.secret).toBe(RUNNER_SECRET);
    const { P } = freshApps();
    const r = await call({
      token: await mint(P, V1),
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'newline' } },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(runner.seen).toHaveLength(1);
  });

  it('positive control: a response 55 s old (inside the ±60 s window) is accepted', async () => {
    stub.mode = 'skewok';
    const { P } = freshApps();
    const r = await call({
      token: await mint(P, V1),
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'skewed' } },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('every request to the runner is HMAC-signed over its exact body bytes', async () => {
    // A capture server: records the raw request and answers 500 (so the write is refused 503).
    const captured: { sig: unknown; raw: string }[] = [];
    const capture = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        captured.push({
          sig: req.headers['x-storage-hook-sig'],
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(500).end();
      });
    });
    const url = await listen(capture);
    try {
      setEnv({ STORAGE_HOOK_RUNNER_URL: url, STORAGE_HOOK_RUNNER_SECRET: RUNNER_SECRET });
      const { P } = freshApps();
      const r = await call({
        token: await mint(P, V1),
        method: 'POST',
        path: '/cards',
        body: { data: { title: 'signed' } },
      });
      expect(r.status).toBe(503);
      expect(captured).toHaveLength(1);
      expect(captured[0].sig).toBe(hmac(RUNNER_SECRET, captured[0].raw));
      // Negative control: another secret's signature is not it.
      expect(captured[0].sig).not.toBe(hmac(`${RUNNER_SECRET}x`, captured[0].raw));
    } finally {
      await new Promise<void>((resolve) => capture.close(() => resolve()));
    }
  });

  it('a tally fails closed too: mark and increment are 503 and change nothing', async () => {
    const { P } = freshApps();
    const token = await mint(P, V1);
    const c = await call({ token, method: 'POST', path: '/cards', body: { data: { title: 'c' } } });
    const key = c.body.key as string;
    stub.mode = '500';
    for (const [method, p] of [
      ['PUT', `/cards/${key}/marks/star`],
      ['POST', `/cards/${key}/counters/likes`],
    ] as const) {
      const r = await call({ token, method, path: p });
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('hook_unavailable');
    }
    stub.mode = 'ok';
    const doc = (await call({ token, method: 'GET', path: `/cards/${key}` })).body;
    expect([doc.counters, doc.marks]).toEqual([{ likes: 0 }, { star: 0 }]);
  });

  it('the client timeout covers the runner backstop, queueing and the network, not just timeoutMs', async () => {
    const m = await importRunner();
    // The mirror of the runner's backstop is the runner's own value.
    expect(HOOK_RUNNER_BACKSTOP_MS).toBe(m.BACKSTOP_MS);
    for (const t of [1, 50, 200, 500]) {
      expect(hookClientTimeoutMs(t)).toBeGreaterThanOrEqual(t + m.BACKSTOP_MS + 250);
    }
  });
});

// ---------------------------------------------------------------------------
// The runner-offline lever
// ---------------------------------------------------------------------------

describe('the per-app runner-offline flag', () => {
  let runner: Runner;
  beforeAll(async () => {
    runner = await startStubRunner();
  });
  afterAll(async () => {
    await runner?.close();
  });
  useRunner(() => runner);

  it('on for an app: its hooked writes are 503 without a call; another app is unaffected', async () => {
    const { P } = freshApps();
    const other = freshApps().P;
    h.offline = new Set([P.id]);
    const offline0 = await hookCalls('offline');
    const r = await call({
      token: await mint(P, V1),
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'x' } },
    });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('hook_unavailable');
    expect(runner.seen).toHaveLength(0);
    expect((await hookCalls('offline')) - offline0).toBe(1);
    // Evaluated per app: entityId = the app block id, no context.
    expect(h.fliptCalls.filter((c) => c.flag === OFFLINE_FLAG)).toEqual([
      { flag: OFFLINE_FLAG, entityId: P.id, context: undefined },
    ]);
    const ok = await call({
      token: await mint(other, V1),
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'x' } },
    });
    expect(ok.status).toBe(201);
    expect(runner.seen).toHaveLength(1);
  });

  it('Flipt unreachable: the normal path (the hook is still called)', async () => {
    const { P } = freshApps();
    h.offline = 'throw';
    const token = await mint(P, V1);
    const ok = await call({
      token,
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'x' } },
    });
    expect(ok.status).toBe(201);
    const no = await call({
      token,
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'DENY' } },
    });
    expect(no.status).toBe(403);
    expect(runner.seen).toHaveLength(2);
  });

  // A review preview's `ctx.appId` is its publish request's id: the lever must still reach it, by
  // the request's app block id (or the request's own id for a first submission, with no app).
  it.each([
    ['an app with an approved version', true],
    ['a first submission (no app yet)', false],
  ] as const)(
    'on for the app: a REVIEW preview write is 503 without a call (%s)',
    async (_label, hasApp) => {
      const { P } = freshApps();
      const publishRequestId = `pubreq_hookrev${seq}${hasApp ? 'a' : 'b'}`;
      dbMock.dbWrite.appBlockPublishRequest.findUnique.mockResolvedValue({
        status: 'pending',
        manifest: P_MANIFEST,
        appBlockId: hasApp ? P.id : null,
      } as never);
      const token = await mint(P, V1, SCOPES, { publishRequestId });
      const lever = hasApp ? P.id : publishRequestId;
      // Positive control: lever off, the review write is decided by the hook and lands.
      const ok = await call({
        token,
        method: 'POST',
        path: '/cards',
        body: { data: { title: 'r' } },
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(runner.seen).toHaveLength(1);
      h.offline = new Set([lever]);
      h.fliptCalls = [];
      const r = await call({
        token,
        method: 'POST',
        path: '/cards',
        body: { data: { title: 'r' } },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(503);
      expect(r.body.code).toBe('hook_unavailable');
      expect(runner.seen).toHaveLength(1);
      expect(h.fliptCalls.filter((c) => c.flag === OFFLINE_FLAG)).toEqual([
        { flag: OFFLINE_FLAG, entityId: lever, context: undefined },
      ]);
    }
  );

  it('a collection without a hook never consults the flag or the runner', async () => {
    const { P } = freshApps();
    h.offline = new Set([P.id]);
    const r = await call({
      token: await mint(P, V1),
      method: 'POST',
      path: '/plain',
      body: { data: { title: 'x' } },
    });
    expect(r.status).toBe(201);
    expect(runner.seen).toHaveLength(0);
    expect(h.fliptCalls.filter((c) => c.flag === OFFLINE_FLAG)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The write is pinned to what the hook saw
// ---------------------------------------------------------------------------

describe('a change between the hook and the write is a version_conflict', () => {
  let runner: Runner;
  beforeAll(async () => {
    runner = await startStubRunner();
  });
  afterAll(async () => {
    await runner?.close();
  });
  useRunner(() => runner);

  /** While the hook decides the FIRST call, another write to the card lands. */
  function raceOnce(token: string, key: string) {
    let raced = false;
    stub.beforeAnswer = async () => {
      if (raced) return;
      raced = true;
      const sneak = await call({
        token,
        method: 'PUT',
        path: `/cards/${key}`,
        body: { data: { title: 'sneaked in', locked: true } },
      });
      expect(sneak.status).toBe(200);
    };
  }

  it.each([
    ['put', 'PUT', '', { data: { title: 'mine' } }],
    ['delete', 'DELETE', '', undefined],
    ['mark', 'PUT', '/marks/star', undefined],
    ['increment', 'POST', '/counters/likes', { by: 1 }],
  ] as const)('%s', async (_op, method, suffix, body) => {
    const { P } = freshApps();
    const token = await mint(P, V1);
    const c = await call({ token, method: 'POST', path: '/cards', body: { data: { title: 'c' } } });
    const key = c.body.key as string;
    raceOnce(token, key);
    const r = await call({ token, method, path: `/cards/${key}${suffix}`, body });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.code).toBe('version_conflict');
    // What landed is the racing write, and nothing of the refused one.
    const doc = (await call({ token, method: 'GET', path: `/cards/${key}` })).body;
    expect(doc).toMatchObject({
      data: { title: 'sneaked in', locked: true },
      counters: {},
      marks: {},
    });
  });

  it('a stale ifVersion is refused before the hook is asked', async () => {
    const { P } = freshApps();
    const token = await mint(P, V1);
    const c = await call({ token, method: 'POST', path: '/cards', body: { data: { title: 'c' } } });
    runner.seen.length = 0;
    const r = await call({
      token,
      method: 'PUT',
      path: `/cards/${c.body.key}`,
      body: { data: { title: 'x' }, ifVersion: 7 },
    });
    expect(r.status).toBe(409);
    expect(runner.seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Default off: no hook declared → the write path never reaches the hook machinery
// ---------------------------------------------------------------------------

describe('default off: a collection whose approved manifest declares no hook', () => {
  let runner: Runner;
  beforeAll(async () => {
    runner = await startStubRunner();
  });
  afterAll(async () => {
    await runner?.close();
  });
  useRunner(() => runner);

  const OUTCOMES = [
    'allow',
    'denied',
    'error',
    'timeout',
    'oom',
    'stack_overflow',
    'invalid_result',
    'unavailable',
    'offline',
  ];
  const allHookCalls = async () => Promise.all(OUTCOMES.map((o) => hookCalls(o)));

  /** Every write op on `plain` (no hook): create, put, both tally routes, delete. */
  async function everyWrite(token: string): Promise<number[]> {
    const c = await call({ token, method: 'POST', path: '/plain', body: { data: { t: 'a' } } });
    const key = c.body.key as string;
    const statuses = [c.status];
    for (const [method, p, body] of [
      ['PUT', `/plain/${key}`, { data: { t: 'b' } }],
      ['PATCH', `/plain/${key}`, { $mark: 'star' }],
      ['PATCH', `/plain/${key}`, { $unmark: 'star' }],
      ['PUT', `/plain/${key}/marks/star`, undefined],
      ['DELETE', `/plain/${key}/marks/star`, undefined],
      ['DELETE', `/plain/${key}`, undefined],
    ] as const) {
      statuses.push((await call({ token, method, path: p, body })).status);
    }
    return statuses;
  }
  const LANDED = [201, 200, 200, 200, 200, 200, 200];

  it('every write lands with no runner call, no hook-source read, no offline-flag read and no hook metric', async () => {
    const { P } = freshApps();
    const token = await mint(P, V1);
    const metrics0 = await allHookCalls();
    expect(await everyWrite(token)).toEqual(LANDED);
    expect(runner.seen).toHaveLength(0);
    expect(sourceReads).toEqual({});
    expect(h.fliptCalls.filter((c) => c.flag === OFFLINE_FLAG)).toEqual([]);
    expect(await allHookCalls()).toEqual(metrics0);
    // Positive control, same app and runner: the hooked collection IS decided by its hook.
    const hooked = await call({
      token,
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'x' } },
    });
    expect(hooked.status).toBe(201);
    expect(runner.seen).toHaveLength(1);
  });

  it('with the runner NOT configured, every write still lands; a hooked write is 503 (positive control)', async () => {
    setEnv({ STORAGE_HOOK_RUNNER_URL: '', STORAGE_HOOK_RUNNER_SECRET: '' });
    const { P } = freshApps();
    const token = await mint(P, V1);
    expect(await everyWrite(token)).toEqual(LANDED);
    const hooked = await call({
      token,
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'x' } },
    });
    expect(hooked.status).toBe(503);
    expect(hooked.body.code).toBe('hook_unavailable');
  });
});

// ---------------------------------------------------------------------------
// The App Storage features merged since: publish/unpublish, unchanged writes, content levels
// ---------------------------------------------------------------------------

describe('publish, unpublish, unchanged writes and content levels on a hooked collection', () => {
  let runner: Runner;
  beforeAll(async () => {
    runner = await startStubRunner();
  });
  afterAll(async () => {
    await runner?.close();
  });
  useRunner(() => runner);

  it('publish INTO a hooked collection is refused hooked_collection, nothing written; into an unhooked one it lands', async () => {
    h.flagsOn.add(PUBLISH_FLAG);
    const { P } = freshApps();
    const token = await mint(P, V1);
    const n = await call({
      token,
      method: 'POST',
      path: '/notes',
      body: { data: { title: 'n1' } },
    });
    expect(n.status).toBe(201);
    const key = n.body.key as string;
    runner.seen.length = 0;
    const refused = await call({
      token,
      method: 'POST',
      path: '/_publish/cards',
      body: { from: 'notes', keys: [key] },
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body).toMatchObject({
      code: 'invalid_request',
      details: { reason: 'hooked_collection', collection: 'cards' },
    });
    expect((await call({ token, method: 'GET', path: `/cards/${key}` })).status).toBe(404);
    expect(runner.seen).toHaveLength(0);
    // Positive control: the same publish into the unhooked shared collection lands.
    const ok = await call({
      token,
      method: 'POST',
      path: '/_publish/plain',
      body: { from: 'notes', keys: [key] },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.created).toEqual([key]);
    expect((await call({ token, method: 'GET', path: `/plain/${key}` })).status).toBe(200);
  });

  it('unpublish FROM a hooked collection is refused hooked_collection, the document stays; from an unhooked one it goes', async () => {
    h.flagsOn.add(PUBLISH_FLAG);
    const { P } = freshApps();
    const token = await mint(P, V1);
    const c = await call({ token, method: 'POST', path: '/cards', body: { data: { title: 'c' } } });
    const p = await call({ token, method: 'POST', path: '/plain', body: { data: { t: 'p' } } });
    expect([c.status, p.status]).toEqual([201, 201]);
    runner.seen.length = 0;
    const refused = await call({
      token,
      method: 'POST',
      path: '/_unpublish/cards',
      body: { keys: [c.body.key] },
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.details).toMatchObject({ reason: 'hooked_collection' });
    expect((await call({ token, method: 'GET', path: `/cards/${c.body.key}` })).status).toBe(200);
    expect(runner.seen).toHaveLength(0);
    const ok = await call({
      token,
      method: 'POST',
      path: '/_unpublish/plain',
      body: { keys: [p.body.key] },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.deleted).toEqual([p.body.key]);
  });

  it('unchanged-writes-free on: an unchanged put to a hooked collection is still decided by the hook', async () => {
    h.flagsOn.add(UNCHANGED_FLAG);
    const { P } = freshApps();
    const token = await mint(P, V1);
    const c = await call({ token, method: 'POST', path: '/cards', body: { data: { title: 'L' } } });
    const key = c.body.key as string;
    const locked = { data: { title: 'L', locked: true } };
    expect((await call({ token, method: 'PUT', path: `/cards/${key}`, body: locked })).status).toBe(
      200
    );
    runner.seen.length = 0;
    // The SAME body again: unchanged, but the hook refuses every write to a locked card.
    const again = await call({ token, method: 'PUT', path: `/cards/${key}`, body: locked });
    expect(again.status, JSON.stringify(again.body)).toBe(403);
    expect(again.body).toMatchObject({ code: 'hook_rejected', message: 'put: card is locked' });
    expect(runner.seen.map((x) => x.input.op)).toEqual(['put']);
    // Positive control: on the unhooked collection the same unchanged put is answered free, its
    // version untouched, with no runner call.
    const p = await call({ token, method: 'POST', path: '/plain', body: { data: { t: 'p' } } });
    const same = await call({
      token,
      method: 'PUT',
      path: `/plain/${p.body.key}`,
      body: { data: { t: 'p' } },
    });
    expect(same.status).toBe(200);
    expect(same.body.version).toBe(p.body.version);
    expect(runner.seen).toHaveLength(1);
  });

  it('content levels on: a hooked tally on a document the viewer cannot see never lands and never shows the hook its data', async () => {
    h.levels = true;
    const { P } = freshApps();
    const author = await mint(P, V1);
    const other = await mint(P, V2);
    const c = await call({
      token: author,
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'c' } },
    });
    expect(c.status).toBe(201);
    const key = c.body.key as string;
    // The setup holds: unrated, so hidden from everyone but its author.
    expect((await call({ token: other, method: 'GET', path: `/cards/${key}` })).status).toBe(404);
    runner.seen.length = 0;
    for (const [method, body] of [
      ['PATCH', { $mark: 'star' }],
      ['PATCH', { $inc: { likes: 1 } }],
    ] as const) {
      const r = await call({ token: other, method, path: `/cards/${key}`, body });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.code).toBe('version_conflict');
    }
    expect(runner.seen).toHaveLength(0);
    const doc = (await call({ token: author, method: 'GET', path: `/cards/${key}` })).body;
    expect([doc.counters, doc.marks]).toEqual([{ likes: 0 }, { star: 0 }]);
  });

  /** Rate `key` Blocked (32): hidden from every reader, its own author included. */
  async function blockDoc(key: string) {
    const rows = await harness.raw(
      `UPDATE appdata.doc SET level = 32, rating_status = 'rated', rated_version = version
         WHERE coll = 'cards' AND key = $1 RETURNING version`,
      [key]
    );
    expect(rows).toHaveLength(1);
    return Number(rows[0].version);
  }

  it('content levels on: the AUTHOR of a document they cannot see deletes it through the hook, which is shown its real state', async () => {
    h.levels = true;
    const { P } = freshApps();
    const author = await mint(P, V1);
    const c = await call({
      token: author,
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'mine' } },
    });
    const key = c.body.key as string;
    const version = await blockDoc(key);
    // The setup holds: Blocked is hidden from its author too.
    expect((await call({ token: author, method: 'GET', path: `/cards/${key}` })).status).toBe(404);
    runner.seen.length = 0;
    const r = await call({
      token: author,
      method: 'DELETE',
      path: `/cards/${key}`,
      query: { ifVersion: String(version) },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ deleted: true });
    expect(runner.seen.map((x) => [x.input.op, x.input.before, x.input.doc?.version])).toEqual([
      ['delete', { title: 'mine' }, version],
    ]);
    expect(
      await harness.raw(`SELECT 1 FROM appdata.doc WHERE coll = 'cards' AND key = $1`, [key])
    ).toEqual([]);
  });

  it('content levels on: the AUTHOR puts their own invisible document through the hook, with its real ifVersion', async () => {
    h.levels = true;
    const { P } = freshApps();
    const author = await mint(P, V1);
    const c = await call({
      token: author,
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'mine' } },
    });
    const key = c.body.key as string;
    const version = await blockDoc(key);
    runner.seen.length = 0;
    const r = await call({
      token: author,
      method: 'PUT',
      path: `/cards/${key}`,
      body: { data: { title: 'edited' }, ifVersion: version },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.version).toBe(version + 1);
    expect(runner.seen.map((x) => [x.input.op, x.input.before])).toEqual([
      ['put', { title: 'mine' }],
    ]);
  });

  it("content levels on: a NON-author's put or delete of a document they cannot see is 409, and the hook never sees it", async () => {
    h.levels = true;
    const { P } = freshApps();
    const author = await mint(P, V1);
    const other = await mint(P, V2);
    const c = await call({
      token: author,
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'mine' } },
    });
    const key = c.body.key as string;
    await blockDoc(key);
    runner.seen.length = 0;
    for (const [method, body] of [
      ['PUT', { data: { title: 'theirs' } }],
      ['DELETE', undefined],
    ] as const) {
      const r = await call({ token: other, method, path: `/cards/${key}`, body });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.code).toBe('version_conflict');
    }
    expect(runner.seen).toHaveLength(0);
    const rows = await harness.raw(
      `SELECT data FROM appdata.doc WHERE coll = 'cards' AND key = $1`,
      [key]
    );
    expect(rows.map((r) => r.data)).toEqual([{ title: 'mine' }]);
  });

  it('content levels off (control): the same tally by the same viewer is decided by the hook and lands', async () => {
    h.levels = false;
    const { P } = freshApps();
    const author = await mint(P, V1);
    const other = await mint(P, V2);
    const c = await call({
      token: author,
      method: 'POST',
      path: '/cards',
      body: { data: { title: 'c' } },
    });
    const key = c.body.key as string;
    runner.seen.length = 0;
    const r = await call({
      token: other,
      method: 'PATCH',
      path: `/cards/${key}`,
      body: { $mark: 'star' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(runner.seen.map((x) => [x.input.op, x.input.tally])).toEqual([
      ['mark', { $mark: 'star' }],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Viewer-keyed collections (docs/app-storage-generic-core.md): the hook sees the derived key and,
// in one additive field, the parent; on both runners, so the real runner's strict input schema
// is part of the seam.
// ---------------------------------------------------------------------------

const VK_SECRET = 'viewer-keyed-hooks-secret-9d41c07b3a';
const VK_OPEN_FLAG = 'app-blocks-storage-viewer-keyed-open';
const VK_MANIFEST = {
  scopes: SCOPES,
  storage: {
    collections: {
      votes: {
        visibility: 'shared',
        write: 'own',
        keyedBy: 'parent+viewer',
        hook: hookOf(CARDS_SHA),
      },
      likes: { visibility: 'shared', write: 'own', keyedBy: 'viewer', hook: hookOf(CARDS_SHA) },
    },
  },
};

describe.each(['stub', 'real'] as const)(
  'viewer-keyed writes call the hook (%s runner)',
  (kind) => {
    let runner: Runner;
    beforeAll(async () => {
      runner = kind === 'stub' ? await startStubRunner() : await startRealRunner();
    });
    afterAll(async () => {
      await runner?.close();
    });
    useRunner(() => runner);
    beforeEach(() => {
      setEnv({ APP_STORAGE_VIEWER_KEY_SECRET: VK_SECRET });
      h.flagsOn.add(VK_OPEN_FLAG);
    });
    afterEach(() => setEnv({ APP_STORAGE_VIEWER_KEY_SECRET: undefined }));

    it('🔴 put and delete at the derived key carry `parent`; keyedBy viewer carries null', async () => {
      seq += 1;
      const A = appRow('vk', VK_MANIFEST);
      const token = await mint(A, V1);
      const put = await call({
        token,
        method: 'PUT',
        path: '/votes/@me/rec-7',
        body: { data: { title: 'up' } },
      });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      const key = put.body.key as string;
      expect(key.startsWith('rec-7:')).toBe(true);
      const del = await call({ token, method: 'DELETE', path: '/votes/@me/rec-7' });
      expect(del.status, JSON.stringify(del.body)).toBe(200);
      const like = await call({
        token,
        method: 'PUT',
        path: '/likes/@me',
        body: { data: { title: 'on' } },
      });
      expect(like.status, JSON.stringify(like.body)).toBe(200);
      expect(
        runner.seen.map((x) => [x.input.op, x.input.collection, x.input.key, x.input.parent])
      ).toEqual([
        ['put', 'votes', key, 'rec-7'],
        ['delete', 'votes', key, 'rec-7'],
        ['put', 'likes', like.body.key, null],
      ]);
    });

    it('a hook refusal of a @me write lands nothing', async () => {
      seq += 1;
      const A = appRow('vk', VK_MANIFEST);
      const token = await mint(A, V1);
      const r = await call({
        token,
        method: 'PUT',
        path: '/votes/@me/rec-8',
        body: { data: { title: 'DENY this vote' } },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body).toMatchObject({ code: 'hook_rejected' });
      const after = await call({ token, method: 'GET', path: '/votes/@me/rec-8' });
      expect(after.status).toBe(404);
    });

    it('a collection without keyedBy sends no `parent` at all', async () => {
      const { P } = freshApps();
      const token = await mint(P, V1);
      const c = await call({
        token,
        method: 'POST',
        path: '/cards',
        body: { data: { title: 'c' } },
      });
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      expect(runner.seen).toHaveLength(1);
      expect(Object.keys(runner.seen[0].input)).not.toContain('parent');
    });
  }
);
