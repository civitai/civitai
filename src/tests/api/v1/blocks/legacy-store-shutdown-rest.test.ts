import { readdirSync } from 'node:fs';
import path from 'node:path';
import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClientModule from '~/server/flipt/client';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * The legacy-store shutdown on the REST twins: with `app-blocks-legacy-stores-removed` on, every
 * `/api/v1/blocks/app-storage/*` and `/api/v1/blocks/shared-storage/*` route answers 410 with the
 * stable body and never reaches the store; with it off, or when the flag eval fails, every route
 * reaches its store function exactly as before.
 */

const FLAG = 'app-blocks-legacy-stores-removed';
const GUIDE = 'https://developer.civitai.com/apps/guide/storage#moving-from-the-legacy-stores';

const { mockIsFlipt, fns, mockHandleEndpointError } = vi.hoisted(() => {
  const names = [
    'getAppStorageValue',
    'setAppStorageValue',
    'deleteAppStorageValue',
    'listAppStorageKeys',
    'getAppStorageQuota',
    'listSharedRows',
    'getSharedRow',
    'getSharedCounts',
    'getTopSharedCounters',
    'appendSharedRow',
    'updateSharedRow',
    'voteSharedRow',
    'unvoteSharedRow',
    'withdrawSharedRow',
    'reportSharedRow',
    'incrementSharedCounter',
  ] as const;
  return {
    mockIsFlipt: vi.fn<(flag: string, entityId?: string, context?: unknown) => Promise<boolean>>(),
    fns: Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<
      (typeof names)[number],
      ReturnType<typeof vi.fn>
    >,
    mockHandleEndpointError: vi.fn(),
  };
});

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
  stashBlockActionDetail: () => undefined,
  parseSubjectUserId: () => 29,
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: any) => h }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClientModule>()),
  isFlipt: (flag: string, entityId?: string, context?: unknown) =>
    mockIsFlipt(flag, entityId, context),
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: mockHandleEndpointError,
  sendRestRateLimited: vi.fn(),
}));
vi.mock('~/server/services/apps/app-storage.service', async () => {
  const z = await import('zod');
  return {
    getAppStorageValue: fns.getAppStorageValue,
    setAppStorageValue: fns.setAppStorageValue,
    deleteAppStorageValue: fns.deleteAppStorageValue,
    listAppStorageKeys: fns.listAppStorageKeys,
    getAppStorageQuota: fns.getAppStorageQuota,
    appStorageKeyInput: z.object({ key: z.string().min(1).max(200) }),
    appStorageSetInput: z.object({ key: z.string().min(1).max(200), value: z.unknown() }),
    appStorageListInput: z.object({
      prefix: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().max(400).optional(),
    }),
  };
});
vi.mock('~/server/routers/apps-shared.router', async () => {
  const z = await import('zod');
  return {
    listSharedRows: fns.listSharedRows,
    getSharedRow: fns.getSharedRow,
    getSharedCounts: fns.getSharedCounts,
    getTopSharedCounters: fns.getTopSharedCounters,
    appendSharedRow: fns.appendSharedRow,
    updateSharedRow: fns.updateSharedRow,
    voteSharedRow: fns.voteSharedRow,
    unvoteSharedRow: fns.unvoteSharedRow,
    withdrawSharedRow: fns.withdrawSharedRow,
    reportSharedRow: fns.reportSharedRow,
    incrementSharedCounter: fns.incrementSharedCounter,
    SHARED_KEY_MAX: 64,
    SHARED_PREFIX_MAX: 64,
    SHARED_CURSOR_MAX: 200,
    SHARED_LIST_LIMIT_MAX: 100,
    SHARED_LIST_LIMIT_DEFAULT: 50,
    SHARED_COUNTS_KEYS_MAX: 100,
    SHARED_REASON_MAX: 500,
    sharedValueInput: z.object({
      title: z.string().min(1),
      body: z.string().optional(),
      data: z.unknown().optional(),
    }),
  };
});

import appGet from '~/pages/api/v1/blocks/app-storage/get';
import appSet from '~/pages/api/v1/blocks/app-storage/set';
import appDelete from '~/pages/api/v1/blocks/app-storage/delete';
import appList from '~/pages/api/v1/blocks/app-storage/list';
import appQuota from '~/pages/api/v1/blocks/app-storage/quota';
import sharedList from '~/pages/api/v1/blocks/shared-storage/list';
import sharedItem from '~/pages/api/v1/blocks/shared-storage/item';
import sharedCounts from '~/pages/api/v1/blocks/shared-storage/counts';
import sharedTop from '~/pages/api/v1/blocks/shared-storage/top';
import sharedAppend from '~/pages/api/v1/blocks/shared-storage/append';
import sharedUpdate from '~/pages/api/v1/blocks/shared-storage/update';
import sharedVote from '~/pages/api/v1/blocks/shared-storage/vote';
import sharedUnvote from '~/pages/api/v1/blocks/shared-storage/unvote';
import sharedWithdraw from '~/pages/api/v1/blocks/shared-storage/withdraw';
import sharedReport from '~/pages/api/v1/blocks/shared-storage/report';
import sharedIncrement from '~/pages/api/v1/blocks/shared-storage/increment';

type Handler = (req: any, res: any) => unknown;
type Route = {
  store: 'app' | 'shared';
  name: string;
  handler: Handler;
  method: 'GET' | 'POST';
  body?: unknown;
  query?: Record<string, unknown>;
  fn: keyof typeof fns;
  returns: unknown;
};

const KEY = '01JQ8KZ3M4N5P6Q7R8S9T0V1W2';

const ROUTES: Route[] = [
  {
    store: 'app',
    name: 'get',
    handler: appGet,
    method: 'POST',
    body: { key: 'k' },
    fn: 'getAppStorageValue',
    returns: { value: null },
  },
  {
    store: 'app',
    name: 'set',
    handler: appSet,
    method: 'POST',
    body: { key: 'k', value: 1 },
    fn: 'setAppStorageValue',
    returns: { ok: true },
  },
  {
    store: 'app',
    name: 'delete',
    handler: appDelete,
    method: 'POST',
    body: { key: 'k' },
    fn: 'deleteAppStorageValue',
    returns: { ok: true },
  },
  {
    store: 'app',
    name: 'list',
    handler: appList,
    method: 'POST',
    body: {},
    fn: 'listAppStorageKeys',
    returns: { items: [] },
  },
  {
    store: 'app',
    name: 'quota',
    handler: appQuota,
    method: 'POST',
    body: {},
    fn: 'getAppStorageQuota',
    returns: { usedBytes: 0 },
  },
  {
    store: 'shared',
    name: 'list',
    handler: sharedList,
    method: 'GET',
    query: {},
    fn: 'listSharedRows',
    returns: { items: [] },
  },
  {
    store: 'shared',
    name: 'item',
    handler: sharedItem,
    method: 'GET',
    query: { key: KEY },
    fn: 'getSharedRow',
    returns: { item: null },
  },
  {
    store: 'shared',
    name: 'counts',
    handler: sharedCounts,
    method: 'GET',
    query: { keys: KEY },
    fn: 'getSharedCounts',
    returns: { counts: {} },
  },
  {
    store: 'shared',
    name: 'top',
    handler: sharedTop,
    method: 'GET',
    query: {},
    fn: 'getTopSharedCounters',
    returns: [],
  },
  {
    store: 'shared',
    name: 'append',
    handler: sharedAppend,
    method: 'POST',
    body: { value: { title: 't' } },
    fn: 'appendSharedRow',
    returns: { key: KEY },
  },
  {
    store: 'shared',
    name: 'update',
    handler: sharedUpdate,
    method: 'POST',
    body: { key: KEY, value: { title: 't' } },
    fn: 'updateSharedRow',
    returns: { ok: true },
  },
  {
    store: 'shared',
    name: 'vote',
    handler: sharedVote,
    method: 'POST',
    body: { key: KEY },
    fn: 'voteSharedRow',
    returns: { count: 1 },
  },
  {
    store: 'shared',
    name: 'unvote',
    handler: sharedUnvote,
    method: 'POST',
    body: { key: KEY },
    fn: 'unvoteSharedRow',
    returns: { count: 0 },
  },
  {
    store: 'shared',
    name: 'withdraw',
    handler: sharedWithdraw,
    method: 'POST',
    body: { key: KEY },
    fn: 'withdrawSharedRow',
    returns: { ok: true },
  },
  {
    store: 'shared',
    name: 'report',
    handler: sharedReport,
    method: 'POST',
    body: { key: KEY },
    fn: 'reportSharedRow',
    returns: { ok: true },
  },
  {
    store: 'shared',
    name: 'increment',
    handler: sharedIncrement,
    method: 'POST',
    body: { key: 'plays' },
    fn: 'incrementSharedCounter',
    returns: { count: 1 },
  },
];

function createMocks(route: Route) {
  const req = {
    method: route.method,
    body: route.body,
    query: route.query ?? {},
    url: `/api/v1/blocks/${route.store}-storage/${route.name}`,
    headers: { authorization: 'Bearer tok_legacy', host: 'civitai.test' },
    socket: { remoteAddress: '203.0.113.7' },
  };
  let statusCode = 200;
  let payload: unknown;
  const res = {
    statusCode: 200,
    status(c: number) {
      statusCode = c;
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
    _status: () => statusCode,
    _json: () => payload,
  };
  return { req, res };
}

const fakeClaims = {
  iss: 'civitai',
  aud: 'civitai-app-block',
  sub: 'user:29',
  iat: 0,
  exp: 0,
  jti: 'j',
  blockId: 'b',
  appId: 'a',
  appBlockId: 'apb',
  blockInstanceId: 'bki',
  ctx: {},
  scopes: [
    'apps:storage:read',
    'apps:storage:write',
    'apps:storage:shared:read',
    'apps:storage:shared:write',
  ],
} as unknown as BlockTokenClaims;

const label = (r: Route) => `${r.store}-storage/${r.name}`;

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims;
  mockIsFlipt.mockResolvedValue(false);
  for (const r of ROUTES) fns[r.fn].mockResolvedValue(r.returns);
});

describe('legacy-store shutdown — REST', () => {
  it('covers every route under both legacy-store directories', () => {
    const dir = path.resolve(__dirname, '../../../../pages/api/v1/blocks');
    const onDisk = ['app-storage', 'shared-storage'].flatMap((d) =>
      readdirSync(path.join(dir, d))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => `${d}/${f.replace(/\.ts$/, '')}`)
    );
    expect(onDisk.length).toBeGreaterThan(0);
    expect(onDisk.sort()).toEqual(ROUTES.map(label).sort());
  });

  it.each(ROUTES.map((r) => [label(r), r] as const))(
    'flag on: %s answers 410 with the stable body and never reaches the store',
    async (_name, route) => {
      mockIsFlipt.mockImplementation(async (flag) => flag === FLAG);
      const { req, res } = createMocks(route);

      await route.handler(req, res);

      expect(res._status()).toBe(410);
      expect(res._json()).toEqual({
        error: 'legacy_store_removed',
        message:
          route.store === 'app'
            ? `legacy_store_removed: the legacy app storage (useAppStorage) has been removed. Move this app to the document store: ${GUIDE}`
            : `legacy_store_removed: the legacy shared storage (useSharedStorage) has been removed. Move this app to the document store: ${GUIDE}`,
        docs: GUIDE,
      });
      expect(fns[route.fn]).not.toHaveBeenCalled();
    }
  );

  it.each(ROUTES.map((r) => [label(r), r] as const))(
    'flag off: %s reaches its store function',
    async (_name, route) => {
      const { req, res } = createMocks(route);

      await route.handler(req, res);

      expect(fns[route.fn]).toHaveBeenCalledTimes(1);
      expect(res._status()).not.toBe(410);
    }
  );

  // Invariant guard (green before the change too): a failing flag eval must leave the legacy
  // stores working, never turn them off.
  it.each(ROUTES.map((r) => [label(r), r] as const))(
    'flag eval throws: %s still reaches its store function',
    async (_name, route) => {
      mockIsFlipt.mockRejectedValue(new Error('flipt unreachable'));
      const { req, res } = createMocks(route);

      await route.handler(req, res);

      expect(fns[route.fn]).toHaveBeenCalledTimes(1);
      expect(res._status()).not.toBe(410);
    }
  );

  it('counts each refusal by store and transport', async () => {
    mockIsFlipt.mockImplementation(async (flag) => flag === FLAG);
    const read = async (store: string) => {
      const metric = client.register.getSingleMetric(
        'civitai_app_block_legacy_store_refusals_total'
      );
      const values = metric ? (await metric.get()).values : [];
      return values.find((v) => v.labels.store === store && v.labels.transport === 'rest')?.value;
    };
    const appBefore = (await read('app')) ?? 0;
    const sharedBefore = (await read('shared')) ?? 0;
    const appRoute = ROUTES.find((r) => r.store === 'app')!;
    const sharedRoute = ROUTES.find((r) => r.store === 'shared')!;

    const a = createMocks(appRoute);
    await appRoute.handler(a.req, a.res);
    const s1 = createMocks(sharedRoute);
    await sharedRoute.handler(s1.req, s1.res);
    const s2 = createMocks(sharedRoute);
    await sharedRoute.handler(s2.req, s2.res);

    expect(await read('app')).toBe(appBefore + 1);
    expect(await read('shared')).toBe(sharedBefore + 2);
  });
});
