import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { EntityAccessPermission } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Download links end to end through the three routes: mint (`POST /api/v1/download-links`), use
 * (`GET /api/download/l/<id>`) and revoke (`DELETE /api/v1/download-links/<linkId>`).
 *
 * The access decision runs for real — `checkGenerationFetch` over the real `hasEntityAccess` — with
 * only its data reads faked by the small world below, so each refusal here is the production rule
 * refusing, not a mock answering. Redis is an in-memory store with the semantics the code relies on
 * (HINCRBY atomic per call, PXAT expiry, scripts run whole).
 */

const { mockIsFlipt, mockSessions, mockResolveDownloadUrl, mockModelVersionEvent, world } =
  vi.hoisted(() => ({
    mockIsFlipt: vi.fn(),
    mockSessions: new Map<string, unknown>(),
    mockResolveDownloadUrl: vi.fn(),
    mockModelVersionEvent: vi.fn(),
    world: {
      versions: new Map<number, Record<string, any>>(),
      files: [] as Record<string, any>[],
      paidAccess: new Map<number, { endsAt: Date | null }>(),
      grants: [] as { userId: number; versionId: number; permissions: number }[],
      users: new Map<number, { id: number; bannedAt: Date | null; deletedAt: Date | null }>(),
      apiKeys: new Map<number, { expiresAt: Date | null }>(),
      clients: new Map<string, { userId: number; grants: string[] }>(),
    },
  }));

vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { DOWNLOAD_LINKS_ENABLED: 'download-links-enabled' },
  isFlipt: mockIsFlipt,
}));
vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: async (token: string) => mockSessions.get(token) ?? null,
}));
vi.mock('~/server/utils/url-helpers', () => ({ getBaseUrl: () => 'https://civitai.com' }));
vi.mock('~/utils/delivery-worker', () => ({ resolveDownloadUrl: mockResolveDownloadUrl }));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    modelVersionEvent = mockModelVersionEvent;
  },
}));
vi.mock('~/server/services/file.service', () => ({
  getDownloadFilename: ({ file }: { file: { name: string } }) => file.name,
}));
vi.mock('~/server/db/kyselyDb.lazy', () => ({
  loadKyselyDb: async () => ({ kyselyRead: {} }),
}));
vi.mock('~/server/services/hot-reads-5.reads', () => ({
  readModelVersionForFileViaKysely: async (_db: unknown, id: number) => {
    const v = world.versions.get(id);
    if (!v) return null;
    return {
      id: v.id,
      status: v.status,
      model: {
        id: v.modelId,
        name: 'Model',
        type: 'LORA',
        publishedAt: null,
        status: v.modelStatus,
        userId: v.ownerId,
        mode: v.mode,
        nsfw: false,
        availability: v.availability,
        poi: v.poi,
      },
      name: 'v1',
      trainedWords: [],
      createdAt: new Date(0),
      requireAuth: v.requireAuth,
      usageControl: v.usageControl,
      baseModel: 'SDXL 1.0',
    };
  },
}));
vi.mock('~/server/services/hot-reads-6.reads', () => ({
  readDownloadFilesViaKysely: async (
    _db: unknown,
    where: { modelVersionId: number; publicOnly?: boolean }
  ) =>
    world.files.filter(
      (f) =>
        f.versionId === where.modelVersionId && (!where.publicOnly || f.visibility === 'Public')
    ),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: async (_type: string, ids: number[]) =>
    Object.fromEntries(
      ids.filter((id) => world.paidAccess.has(id)).map((id) => [id, world.paidAccess.get(id)])
    ),
}));
vi.mock('~/server/redis/caches', () => ({
  modelVersionAccessCache: { fetch: async () => ({}) },
  lookupModelVersionAccess: async (ids: number[]) =>
    Object.fromEntries(
      ids
        .filter((id) => world.versions.has(id))
        .map((id) => {
          const v = world.versions.get(id)!;
          return [id, { entityId: id, userId: v.ownerId, availability: v.availability }];
        })
    ),
}));

import mintHandler from '~/pages/api/v1/download-links/index';
import revokeHandler from '~/pages/api/v1/download-links/[linkId]';
import linkHandler from '~/pages/api/download/l/[id]';
import { revokeLinksOfRevokedCredentials } from '~/server/services/download-link/download-link.store';

// ---------------------------------------------------------------------------------------------
// In-memory sysRedis.

type Entry =
  | { type: 'hash'; value: Map<string, string>; expiresAt: number | null }
  | { type: 'string'; value: string; expiresAt: number | null }
  | { type: 'set'; value: Set<string>; expiresAt: number | null };

let store = new Map<string, Entry>();
const live = (key: string) => {
  const entry = store.get(key);
  if (entry && entry.expiresAt != null && entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry;
};
const ops = {
  hSet(key: string, fields: Record<string, string>) {
    const entry = live(key);
    const hash = entry?.type === 'hash' ? entry.value : new Map<string, string>();
    for (const [k, v] of Object.entries(fields)) hash.set(k, String(v));
    store.set(key, { type: 'hash', value: hash, expiresAt: entry?.expiresAt ?? null });
  },
  pExpireAt(key: string, at: number) {
    const entry = live(key);
    if (entry) entry.expiresAt = at;
  },
  expire(key: string, seconds: number) {
    const entry = live(key);
    if (entry) entry.expiresAt = Date.now() + seconds * 1000;
  },
  set(key: string, value: string, options?: { PXAT?: number }) {
    store.set(key, { type: 'string', value, expiresAt: options?.PXAT ?? null });
  },
  sAdd(key: string, member: string) {
    const entry = live(key);
    const set = entry?.type === 'set' ? entry.value : new Set<string>();
    set.add(member);
    store.set(key, { type: 'set', value: set, expiresAt: entry?.expiresAt ?? null });
  },
  incrBy(key: string, by: number) {
    const entry = live(key);
    const next = (entry?.type === 'string' ? Number(entry.value) : 0) + by;
    store.set(key, { type: 'string', value: String(next), expiresAt: entry?.expiresAt ?? null });
    return next;
  },
};
// An await between every command, as over a socket, so concurrent callers really interleave.
const tick = () => new Promise((resolve) => setImmediate(resolve));

function installFakeSysRedis() {
  store = new Map();
  const r = redisMock.sysRedis;
  r.hGetAll.mockImplementation(async (key: string) => {
    await tick();
    const entry = live(key);
    return entry?.type === 'hash' ? Object.fromEntries(entry.value) : {};
  });
  r.get.mockImplementation(async (key: string) => {
    await tick();
    const entry = live(key);
    return entry?.type === 'string' ? entry.value : null;
  });
  r.del.mockImplementation(async (keys: string | string[]) => {
    await tick();
    for (const key of [keys].flat()) store.delete(key);
    return 1;
  });
  r.sRem.mockImplementation(async (key: string, member: string) => {
    await tick();
    const entry = live(key);
    if (entry?.type === 'set') entry.value.delete(member);
    return 1;
  });
  r.sMembers.mockImplementation(async (key: string) => {
    await tick();
    const entry = live(key);
    return entry?.type === 'set' ? [...entry.value] : [];
  });
  r.eval.mockImplementation(
    async (script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) => {
      await tick();
      if (script.includes('HINCRBY')) {
        const entry = live(keys[0]);
        if (entry?.type !== 'hash') return -1;
        const next = Number(entry.value.get('fetches') ?? 0) + 1;
        entry.value.set('fetches', String(next));
        return next;
      }
      if (script.includes("'GET'")) {
        const entry = live(keys[0]);
        if (entry?.type === 'string' && entry.value === args[0]) store.delete(keys[0]);
        return 0;
      }
      throw new Error('unknown script');
    }
  );
  r.multi.mockImplementation(() => {
    const queued: (() => unknown)[] = [];
    const chain: Record<string, unknown> = {
      exec: async () => {
        await tick();
        return queued.map((run) => run());
      },
    };
    for (const name of Object.keys(ops) as (keyof typeof ops)[]) {
      chain[name] = (...args: unknown[]) => {
        queued.push(() => (ops[name] as (...a: unknown[]) => unknown)(...args));
        return chain;
      };
    }
    return chain;
  });
}

// ---------------------------------------------------------------------------------------------
// Requests.

type Captured = {
  status: number;
  body: any;
  headers: Record<string, string>;
  location?: string;
};

function makeRes() {
  const captured: Captured = { status: 200, body: undefined, headers: {} };
  const res = {
    headersSent: false,
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
    end() {
      return res;
    },
    redirect(code: number, url: string) {
      captured.status = code;
      captured.location = url;
      return res;
    },
  };
  return { res: res as unknown as NextApiResponse, captured };
}

async function mint(items: unknown[], token = 'tok-client') {
  const { res, captured } = makeRes();
  const req = {
    method: 'POST',
    url: '/api/v1/download-links',
    headers: { authorization: `Bearer ${token}` },
    query: {},
    body: { items },
  } as unknown as NextApiRequest;
  await mintHandler(req, res);
  return captured;
}

async function fetchLink(url: string) {
  const id = url.split('/api/download/l/')[1];
  const { res, captured } = makeRes();
  const req = {
    method: 'GET',
    url: `/api/download/l/${id}`,
    headers: {},
    query: { id },
  } as unknown as NextApiRequest;
  await linkHandler(req, res);
  return captured;
}

async function revoke(linkId: string, token = 'tok-client') {
  const { res, captured } = makeRes();
  const req = {
    method: 'DELETE',
    url: `/api/v1/download-links/${linkId}`,
    headers: { authorization: `Bearer ${token}` },
    query: { linkId },
  } as unknown as NextApiRequest;
  await revokeHandler(req, res);
  return captured;
}

// ---------------------------------------------------------------------------------------------
// The world.

const OWNER = 10;
const USER = 20;
const MODERATOR = 30;
const BANNED = 40;

const PUBLIC_VERSION = 100;
const GENERATION_ONLY = 101;
const PRIVATE_VERSION = 102;
const EARLY_ACCESS = 103;
const TAKEN_DOWN = 104;
const POI_VERSION = 105;
const DELETED = 106;
const FAILED_SCAN = 107;
const INTERNAL_ONLY = 108;

function version(id: number, overrides: Record<string, unknown> = {}) {
  world.versions.set(id, {
    id,
    modelId: id * 10,
    ownerId: OWNER,
    status: 'Published',
    modelStatus: 'Published',
    mode: null,
    poi: false,
    availability: 'Public',
    requireAuth: false,
    usageControl: 'Download',
    ...overrides,
  });
  world.files.push({
    id: id * 100,
    versionId: id,
    url: `https://bucket/${id}.safetensors`,
    name: `${id}.safetensors`,
    overrideName: null,
    type: 'Model',
    metadata: {},
    sizeKB: 1000,
    pickleScanResult: 'Success',
    virusScanResult: 'Success',
    visibility: 'Public',
    hashes: [],
  });
}
const fileOf = (versionId: number) => versionId * 100;

function seedWorld() {
  world.versions.clear();
  world.files.length = 0;
  world.paidAccess.clear();
  world.grants.length = 0;
  world.users.clear();
  world.apiKeys.clear();
  world.clients.clear();

  for (const id of [OWNER, USER, MODERATOR])
    world.users.set(id, { id, bannedAt: null, deletedAt: null });
  world.users.set(BANNED, { id: BANNED, bannedAt: new Date(), deletedAt: null });

  version(PUBLIC_VERSION);
  version(GENERATION_ONLY, { usageControl: 'Generation' });
  version(PRIVATE_VERSION, { availability: 'Private' });
  version(EARLY_ACCESS);
  world.paidAccess.set(EARLY_ACCESS, { endsAt: null });
  version(TAKEN_DOWN, { mode: 'TakenDown' });
  version(POI_VERSION, { poi: true });
  version(DELETED, { modelStatus: 'Deleted' });
  version(FAILED_SCAN);
  world.files.find((f) => f.versionId === FAILED_SCAN)!.virusScanResult = 'Danger';
  version(INTERNAL_ONLY, { usageControl: 'InternalGeneration' });

  world.clients.set('orch-client', { userId: 900, grants: ['client_credentials'] });
  world.apiKeys.set(555, { expiresAt: null });
  world.apiKeys.set(777, { expiresAt: null });

  mockSessions.clear();
  mockSessions.set('tok-client', {
    user: { id: 900 },
    apiKeyId: 1,
    apiKeyType: 'Access',
    subject: { type: 'oauth', id: 'orch-client' },
    tokenScope: TokenScope.UserRead | TokenScope.DownloadLink,
  });
  mockSessions.set('tok-client-no-bit', {
    user: { id: 900 },
    apiKeyId: 2,
    apiKeyType: 'Access',
    subject: { type: 'oauth', id: 'orch-client' },
    tokenScope: TokenScope.UserRead,
  });
  mockSessions.set('tok-apikey', {
    user: { id: 901 },
    apiKeyId: 555,
    apiKeyType: 'System',
    subject: { type: 'apiKey', id: 555 },
    tokenScope: TokenScope.Full,
  });
  mockSessions.set('tok-not-allowlisted', {
    user: { id: 902 },
    apiKeyId: 777,
    apiKeyType: 'User',
    subject: { type: 'apiKey', id: 777 },
    tokenScope: TokenScope.Full,
  });
}

function wireDb() {
  dbMock.dbRead.user.findUnique.mockImplementation(
    async ({ where }: { where: { id: number } }) => world.users.get(where.id) ?? null
  );
  dbMock.dbRead.apiKey.findUnique.mockImplementation(
    async ({ where }: { where: { id: number } }) => {
      const key = world.apiKeys.get(where.id);
      return key ? { ...key, user: { bannedAt: null, deletedAt: null } } : null;
    }
  );
  dbMock.dbRead.oauthClient.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => world.clients.get(where.id) ?? null
  );
  // hasEntityAccess's EntityAccess read: `(${permissions} & ea.permissions) != 0`, the ids, the
  // entity type, the user.
  dbMock.dbWrite.$queryRaw.mockImplementation(
    async (
      _strings: TemplateStringsArray,
      permissionSql: { values?: unknown[] },
      idsSql: { values: number[] },
      _entityType: string,
      userId: number
    ) => {
      const permissions = permissionSql?.values?.[0] as number | undefined;
      return world.grants
        .filter((g) => g.userId === userId && idsSql.values.includes(g.versionId))
        .map((g) => ({
          entityId: g.versionId,
          hasAccess: permissions ? (permissions & g.permissions) !== 0 : true,
          permissions: g.permissions,
        }));
    }
  );
}

const userItem = (modelVersionId: number, onBehalfOfUserId = USER, extra = {}) => ({
  modelVersionId,
  onBehalfOfUserId,
  workflowId: `${onBehalfOfUserId}-20261107-abc`,
  ...extra,
});

beforeEach(() => {
  seedWorld();
  vi.clearAllMocks();
  wireDb();
  installFakeSysRedis();
  mockIsFlipt.mockResolvedValue(true);
  mockModelVersionEvent.mockResolvedValue(true);
  let n = 0;
  mockResolveDownloadUrl.mockImplementation(async (fileId: number) => ({
    url: `https://storage.example/${fileId}?sig=${++n}`,
    urlExpiryDate: new Date(Date.now() + 6 * 3600_000),
  }));
  setEnv({
    DOWNLOAD_LINK_CLIENT_IDS: ['orch-client'],
    DOWNLOAD_LINK_API_KEY_IDS: ['555'],
    DOWNLOAD_LINK_PUBLIC_CLIENT_IDS: ['orch-client'],
    DOWNLOAD_LINK_PUBLIC_API_KEY_IDS: [],
    DOWNLOAD_LINK_SECRET: 'test-secret-0123456789abcdef0123456789',
    DOWNLOAD_LINK_MAX_FETCHES: 50,
    DOWNLOAD_LINK_MIN_REUSE_SECONDS: 7200,
    DOWNLOAD_LINK_FILE_URL_TTL_SECONDS: 21600,
    DOWNLOAD_LINK_MINT_LIMIT_PER_CREDENTIAL: 3000,
    DOWNLOAD_LINK_MINT_LIMIT_PER_USER: 120,
  });
});

async function mintOne(item: unknown, token?: string) {
  const res = await mint([item], token);
  expect(res.status).toBe(200);
  return res.body.items[0];
}

// ---------------------------------------------------------------------------------------------

describe('positive: generation-only file for an allowed user', () => {
  it('mints a link with no query string that 302s to a fresh signed URL', async () => {
    const result = await mintOne(userItem(GENERATION_ONLY));
    expect(result).toMatchObject({ ok: true, reused: false });
    expect(result.url).toMatch(/^https:\/\/civitai\.com\/api\/download\/l\/[0-9A-Za-z]{22}$/);

    const first = await fetchLink(result.url);
    expect(first.status).toBe(302);
    expect(first.location).toBe(`https://storage.example/${fileOf(GENERATION_ONLY)}?sig=1`);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['referrer-policy']).toBe('no-referrer');
    // The resolve asks for the configured file-URL lifetime.
    expect(mockResolveDownloadUrl.mock.calls[0][3]).toMatchObject({ expiresInSeconds: 21600 });

    const retry = await fetchLink(result.url);
    expect(retry.location).toBe(`https://storage.example/${fileOf(GENERATION_ONLY)}?sig=2`);
  });

  it('records one GenerationFetch on the first fetch only, as the link user', async () => {
    const { url } = await mintOne(userItem(GENERATION_ONLY));
    await fetchLink(url);
    await fetchLink(url);
    await fetchLink(url);
    expect(mockModelVersionEvent).toHaveBeenCalledTimes(1);
    expect(mockModelVersionEvent.mock.calls[0][0]).toMatchObject({
      type: 'GenerationFetch',
      modelVersionId: GENERATION_ONLY,
      fileId: fileOf(GENERATION_ONLY),
    });
  });

  it('resolves the primary file when the item names no fileId, and pins it', async () => {
    const result = await mintOne(userItem(PUBLIC_VERSION));
    expect(result.ok).toBe(true);
    const fetched = await fetchLink(result.url);
    expect(mockResolveDownloadUrl.mock.calls[0][0]).toBe(fileOf(PUBLIC_VERSION));
    expect(fetched.status).toBe(302);
  });

  it('lets the owner fetch their own private version', async () => {
    const result = await mintOne(userItem(PRIVATE_VERSION, OWNER));
    expect(result.ok).toBe(true);
    expect((await fetchLink(result.url)).status).toBe(302);
  });

  it('lets a user who bought early-access generation fetch it', async () => {
    world.grants.push({
      userId: USER,
      versionId: EARLY_ACCESS,
      permissions: EntityAccessPermission.EarlyAccessGeneration,
    });
    const result = await mintOne(userItem(EARLY_ACCESS));
    expect(result.ok).toBe(true);
    expect((await fetchLink(result.url)).status).toBe(302);
  });
});

describe('negative controls at mint', () => {
  it.each([
    ["another user's private file", PRIVATE_VERSION, 'no-access'],
    ['early access not bought', EARLY_ACCESS, 'early-access'],
    ['a taken-down model', TAKEN_DOWN, 'not-found'],
    ['a POI model', POI_VERSION, 'poi'],
    ['a deleted model', DELETED, 'not-found'],
    ['a failed scan', FAILED_SCAN, 'failed-scan'],
    ['an internal-generation version', INTERNAL_ONLY, 'no-generation'],
  ])('refuses %s', async (_name, versionId, error) => {
    const result = await mintOne(userItem(versionId));
    expect(result).toMatchObject({ ok: false, error });
  });

  it('refuses a user whose grant carries download but not generation', async () => {
    world.grants.push({
      userId: USER,
      versionId: EARLY_ACCESS,
      permissions: EntityAccessPermission.EarlyAccessDownload,
    });
    expect(await mintOne(userItem(EARLY_ACCESS))).toMatchObject({
      ok: false,
      error: 'early-access',
    });
  });

  it('refuses a user who cannot generate with a shared private version', async () => {
    // A grant row without the generation bit: the user can see it but not generate with it.
    world.grants.push({
      userId: USER,
      versionId: PRIVATE_VERSION,
      permissions: EntityAccessPermission.EarlyAccessDownload,
    });
    expect(await mintOne(userItem(PRIVATE_VERSION))).toMatchObject({
      ok: false,
      error: 'no-access',
    });
  });

  it('refuses POI and deleted models even for their owner', async () => {
    expect(await mintOne(userItem(POI_VERSION, OWNER))).toMatchObject({ ok: false, error: 'poi' });
    expect(await mintOne(userItem(DELETED, OWNER))).toMatchObject({
      ok: false,
      error: 'not-found',
    });
  });

  it('checks a moderator named on a link as an ordinary user', async () => {
    // The real user row says moderator; the principal is never built from it.
    world.users.set(MODERATOR, {
      id: MODERATOR,
      bannedAt: null,
      deletedAt: null,
      isModerator: true,
    } as never);
    for (const [versionId, error] of [
      [DELETED, 'not-found'],
      [POI_VERSION, 'poi'],
      [PRIVATE_VERSION, 'no-access'],
      [TAKEN_DOWN, 'not-found'],
    ] as const) {
      expect(await mintOne(userItem(versionId, MODERATOR))).toMatchObject({ ok: false, error });
    }
  });

  it('refuses a banned named user', async () => {
    expect(await mintOne(userItem(PUBLIC_VERSION, BANNED))).toMatchObject({
      ok: false,
      error: 'unauthorized',
    });
  });

  it('answers each item in request order', async () => {
    const res = await mint([userItem(POI_VERSION), userItem(PUBLIC_VERSION), userItem(DELETED)]);
    expect(res.body.items.map((i: { ok: boolean }) => i.ok)).toEqual([false, true, false]);
  });
});

describe('who may mint', () => {
  it('403s an ApiKey not on the allowlist, and mints nothing', async () => {
    const res = await mint([userItem(PUBLIC_VERSION)], 'tok-not-allowlisted');
    expect(res.status).toBe(403);
    expect(store.size).toBe(0);
  });

  it('403s an allowlisted client whose token lacks DownloadLink', async () => {
    expect((await mint([userItem(PUBLIC_VERSION)], 'tok-client-no-bit')).status).toBe(403);
  });

  it('401s no credential', async () => {
    expect((await mint([userItem(PUBLIC_VERSION)], 'unknown')).status).toBe(401);
  });

  it('accepts an allowlisted ApiKey', async () => {
    const result = await mintOne(userItem(PUBLIC_VERSION), 'tok-apikey');
    expect(result.ok).toBe(true);
    expect((await fetchLink(result.url)).status).toBe(302);
  });

  it('400s a user item without workflowId', async () => {
    const res = await mint([{ modelVersionId: PUBLIC_VERSION, onBehalfOfUserId: USER }]);
    expect(res.status).toBe(400);
  });

  it('400s a public item that names a user', async () => {
    const res = await mint([
      { mode: 'public', modelVersionId: PUBLIC_VERSION, onBehalfOfUserId: USER },
    ]);
    expect(res.status).toBe(400);
  });

  it('503s while the switch is off', async () => {
    mockIsFlipt.mockResolvedValue(false);
    expect((await mint([userItem(PUBLIC_VERSION)])).status).toBe(503);
  });
});

describe('public mode', () => {
  const publicItem = (modelVersionId: number) => ({ mode: 'public', modelVersionId });

  it('mints and serves a public file', async () => {
    const result = await mintOne(publicItem(PUBLIC_VERSION));
    expect(result.ok).toBe(true);
    expect((await fetchLink(result.url)).status).toBe(302);
  });

  it.each([
    ['an early-access file', EARLY_ACCESS, 'early-access'],
    ['a private file', PRIVATE_VERSION, 'no-access'],
    ['a POI file', POI_VERSION, 'poi'],
  ])('refuses %s', async (_name, versionId, error) => {
    expect(await mintOne(publicItem(versionId))).toMatchObject({ ok: false, error });
  });

  it('refuses a credential not on the public list', async () => {
    expect(await mintOne(publicItem(PUBLIC_VERSION), 'tok-apikey')).toMatchObject({
      ok: false,
      error: 'unauthorized',
    });
  });
});

describe('use', () => {
  it('404s an expired link, judged by the stored expiresAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { url } = await mintOne(userItem(PUBLIC_VERSION, USER, { ttlSeconds: 300 }));
      // The Redis key would still be there if its TTL had been lost; the stored expiresAt decides.
      for (const entry of store.values()) entry.expiresAt = null;
      vi.setSystemTime(Date.now() + 301_000);
      const res = await fetchLink(url);
      expect(res.status).toBe(404);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps fetches under concurrency', async () => {
    const { url } = await mintOne(userItem(PUBLIC_VERSION));
    const results = await Promise.all(Array.from({ length: 70 }, () => fetchLink(url)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 302)).toHaveLength(50);
    expect(statuses.filter((s) => s === 404)).toHaveLength(20);
  });

  it('re-checks access at every use: a takedown after mint 404s', async () => {
    const { url } = await mintOne(userItem(PUBLIC_VERSION));
    world.versions.get(PUBLIC_VERSION)!.mode = 'TakenDown';
    expect((await fetchLink(url)).status).toBe(404);
  });

  it('404s once the named user is banned', async () => {
    const { url } = await mintOne(userItem(PUBLIC_VERSION));
    world.users.get(USER)!.bannedAt = new Date();
    expect((await fetchLink(url)).status).toBe(404);
  });

  it('404s every link while the switch is off', async () => {
    const { url } = await mintOne(userItem(PUBLIC_VERSION));
    mockIsFlipt.mockResolvedValue(false);
    expect((await fetchLink(url)).status).toBe(404);
  });

  it('404s an unknown id without creating a key', async () => {
    const res = await fetchLink('https://civitai.com/api/download/l/AAAAAAAAAAAAAAAAAAAAAA');
    expect(res.status).toBe(404);
    expect(store.size).toBe(0);
  });
});

describe('revoke', () => {
  it('a revoked minting ApiKey kills its links at use (liveness)', async () => {
    const { url } = await mintOne(userItem(PUBLIC_VERSION), 'tok-apikey');
    world.apiKeys.delete(555);
    expect((await fetchLink(url)).status).toBe(404);
  });

  it('an expired minting ApiKey kills its links at use', async () => {
    const { url } = await mintOne(userItem(PUBLIC_VERSION), 'tok-apikey');
    world.apiKeys.set(555, { expiresAt: new Date(Date.now() - 1000) });
    expect((await fetchLink(url)).status).toBe(404);
  });

  it('the credential cascade deletes every link it minted', async () => {
    const a = await mintOne(userItem(PUBLIC_VERSION), 'tok-apikey');
    const b = await mintOne(userItem(GENERATION_ONLY), 'tok-apikey');
    await revokeLinksOfRevokedCredentials([{ kind: 'apikey', id: '555' }]);
    // The key itself is still valid: only the cascade can have refused these.
    expect((await fetchLink(a.url)).status).toBe(404);
    expect((await fetchLink(b.url)).status).toBe(404);
    expect(
      [...store.keys()].filter((k) => k.startsWith('dl:') && !k.startsWith('dl:mint-rate'))
    ).toEqual([]);
  });

  it('revokes one link by linkId, for its minting credential only', async () => {
    const result = await mintOne(userItem(PUBLIC_VERSION));
    expect((await revoke(result.linkId, 'tok-apikey')).status).toBe(404);
    expect((await fetchLink(result.url)).status).toBe(302);
    expect((await revoke(result.linkId)).status).toBe(204);
    expect((await fetchLink(result.url)).status).toBe(404);
  });
});

describe('reuse', () => {
  it('returns the same link for the same credential, file and user', async () => {
    const first = await mintOne(userItem(PUBLIC_VERSION));
    const second = await mintOne(userItem(PUBLIC_VERSION));
    expect(second).toMatchObject({ ok: true, reused: true, url: first.url, linkId: first.linkId });
  });

  it('mints a new link for another user', async () => {
    const first = await mintOne(userItem(PUBLIC_VERSION, USER));
    const other = await mintOne(userItem(PUBLIC_VERSION, OWNER));
    expect(other.reused).toBe(false);
    expect(other.url).not.toBe(first.url);
  });

  it('mints a new link when the existing one has less than the minimum left', async () => {
    const first = await mintOne(userItem(PUBLIC_VERSION, USER, { ttlSeconds: 3600 }));
    const second = await mintOne(userItem(PUBLIC_VERSION));
    expect(second.reused).toBe(false);
    expect(second.url).not.toBe(first.url);
  });

  it('mints fresh after the secret rotates rather than returning a dead URL', async () => {
    const first = await mintOne(userItem(PUBLIC_VERSION));
    setEnv({ DOWNLOAD_LINK_SECRET: 'rotated-secret-abcdef0123456789abcdef' });
    const second = await mintOne(userItem(PUBLIC_VERSION));
    expect(second.reused).toBe(false);
    expect(second.url).not.toBe(first.url);
    // Both work: a rotation changes what can be rebuilt, not which links are valid.
    expect((await fetchLink(first.url)).status).toBe(302);
    expect((await fetchLink(second.url)).status).toBe(302);
  });

  it('never reuses without a secret', async () => {
    setEnv({ DOWNLOAD_LINK_SECRET: undefined });
    const first = await mintOne(userItem(PUBLIC_VERSION));
    const second = await mintOne(userItem(PUBLIC_VERSION));
    expect(second.reused).toBe(false);
    expect(second.url).not.toBe(first.url);
  });
});

describe('mint limits', () => {
  it('answers an item 429 past the per-user limit', async () => {
    setEnv({ DOWNLOAD_LINK_MINT_LIMIT_PER_USER: 2 });
    const res = await mint([
      userItem(PUBLIC_VERSION),
      userItem(GENERATION_ONLY),
      userItem(PUBLIC_VERSION),
    ]);
    expect(res.body.items[2]).toEqual({ ok: false, status: 429, error: 'rate-limited' });
  });

  it('answers the whole call 429 with Retry-After past the per-credential limit', async () => {
    setEnv({ DOWNLOAD_LINK_MINT_LIMIT_PER_CREDENTIAL: 2 });
    const res = await mint([
      userItem(PUBLIC_VERSION),
      userItem(GENERATION_ONLY),
      userItem(PUBLIC_VERSION),
    ]);
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});
