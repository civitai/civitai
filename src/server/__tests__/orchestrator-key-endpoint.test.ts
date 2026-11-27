import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AccountRestriction from '~/server/services/account-restriction.service';
import type * as ApiKeyPrincipalCache from '~/server/auth/api-key-principal-cache';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import type * as KeyGenerator from '~/server/utils/key-generator';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { RESTRICTED_ACCOUNT_MESSAGE } from '~/server/common/content-restriction';
import { addApiKeyInputSchema } from '~/server/schema/api-key.schema';
import { DOCS_API_KEY_SCOPE } from '~/shared/constants/docs-api-key.constants';
import { readApiKeyScope, TokenScope } from '~/shared/constants/token-scope.constants';

// /api/user/orchestrator-key mints the developer docs key: a personal key with a fixed scope, a
// daily Buzz limit and a 30-day expiry, for a browser session on the docs site only.

const USER_ID = 4343;
const HOST = 'civitai.test';
const NAME = `Developer docs (${HOST})`;
const DOCS_ORIGIN = 'https://developer.civitai.com';
const DAY = 86_400_000;

const { getServerAuthSession, assertAccountNotRestricted, revokeCivitaiUserTokens, minted } =
  vi.hoisted(() => ({
    getServerAuthSession: vi.fn(),
    assertAccountNotRestricted: vi.fn(async () => undefined),
    revokeCivitaiUserTokens: vi.fn(async () => true),
    minted: { count: 0 },
  }));

vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession }));
// The cached standing check: it passes here, as it does when the cache has not yet seen a ban.
vi.mock('~/server/services/account-restriction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountRestriction>()),
  assertAccountNotRestricted,
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens,
}));
vi.mock('~/server/auth/api-key-principal-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyPrincipalCache>()),
  evictCachedApiKeys: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateKey: () => `plaintext-${++minted.count}`,
  generateSecretHash: (key: string) => `hash-of-${key}`,
}));

const handler = (await import('~/pages/api/user/orchestrator-key')).default;
const { expireGenerationCredentials } = await import('~/server/services/api-key.service');

type Account = { id: number; bannedAt: Date | null; deletedAt: Date | null };
type KeyRow = {
  id: number;
  key: string;
  name: string;
  userId: number;
  type: string;
  expiresAt: Date | null;
  tokenScope: number;
  tokenScopeWide?: bigint | null;
  buzzLimit?: unknown;
};
type Where = Record<string, unknown>;

let account: Account | null;
let keys: KeyRow[];
let nextId: number;
/** Runs inside the insert, before the new row is visible: a concurrent ban or deletion committing. */
let duringInsert: (() => Promise<void>) | null;

function matches(row: KeyRow, where: Where): boolean {
  return Object.entries(where).every(([field, cond]) => {
    if (field === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    if (field === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    const value = row[field as keyof KeyRow];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; startsWith?: string };
      if (c.in) return c.in.includes(value);
      if (c.startsWith !== undefined) return String(value).startsWith(c.startsWith);
      throw new Error(`unsupported filter on ${field}`);
    }
    return value === cond;
  });
}

/** What a ban or deletion does to keys: expire every row it can see. */
function revokeVisibleKeys() {
  const now = new Date();
  for (const row of keys) if (!row.expiresAt || row.expiresAt > now) row.expiresAt = now;
}

const live = (row: KeyRow) => !row.expiresAt || row.expiresAt > new Date();

const docsKey = (id: number, over: Partial<KeyRow> = {}): KeyRow => ({
  id,
  key: `hash-${id}`,
  name: NAME,
  userId: USER_ID,
  type: 'User',
  tokenScope: Number(DOCS_API_KEY_SCOPE),
  expiresAt: new Date(Date.now() + 10 * DAY),
  ...over,
});
const legacySystemKey = (): KeyRow => ({
  id: 5,
  key: 'hash-legacy',
  name: `orchestrator-key:${HOST}`,
  userId: USER_ID,
  type: 'System',
  tokenScope: Number(TokenScope.Full),
  expiresAt: null,
});

function installTables() {
  dbMock.dbWrite.user.findUnique.mockImplementation((async () =>
    account ? { ...account } : null) as never);
  // A replica that never sees the ban: a refusal must come from the primary.
  dbMock.dbRead.user.findUnique.mockImplementation((async () =>
    account ? { ...account, bannedAt: null, deletedAt: null } : null) as never);
  dbMock.dbWrite.apiKey.create.mockImplementation((async ({ data }: { data: KeyRow }) => {
    if (duringInsert) await duringInsert();
    const row = { ...data, expiresAt: data.expiresAt ?? null, id: nextId++ };
    keys.push(row);
    return row;
  }) as never);
  dbMock.dbWrite.apiKey.findMany.mockImplementation((async ({ where }: { where: Where }) =>
    keys.filter((k) => matches(k, where)).map((k) => ({ ...k }))) as never);
  dbMock.dbWrite.apiKey.deleteMany.mockImplementation((async ({ where }: { where: Where }) => {
    const before = keys.length;
    keys = keys.filter((k) => !matches(k, where));
    return { count: before - keys.length };
  }) as never);
  dbMock.dbWrite.apiKey.updateMany.mockImplementation((async ({
    where,
    data,
  }: {
    where: Where;
    data: { expiresAt: Date };
  }) => {
    const hit = keys.filter((k) => matches(k, where));
    for (const k of hit) k.expiresAt = data.expiresAt;
    return { count: hit.length };
  }) as never);
}

function call({
  method = 'GET',
  /** `null` sends no Origin header. */
  origin = DOCS_ORIGIN as string | null,
  contentType = method === 'POST' ? 'application/json' : undefined,
  authorization = undefined as string | undefined,
} = {}) {
  const headers: Record<string, string> = { host: `${HOST}:443` };
  if (origin !== null) headers.origin = origin;
  if (contentType !== undefined) headers['content-type'] = contentType;
  if (authorization !== undefined) headers.authorization = authorization;
  const req = { method, query: {}, headers, url: '/' };
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(data: Record<string, unknown>) {
      body = data;
      return res;
    },
    send: () => res,
    setHeader: () => res,
    getHeader: () => undefined,
    end: () => res,
  };
  return (
    handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse) as Promise<void>
  ).then(() => ({ status, body }));
}

beforeEach(() => {
  vi.clearAllMocks();
  account = { id: USER_ID, bannedAt: null, deletedAt: null };
  keys = [];
  nextId = 100;
  minted.count = 0;
  duringInsert = null;
  installTables();
  getServerAuthSession.mockResolvedValue({ user: { id: USER_ID } });
  // The orchestrator's spend-record delete for each removed key.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(['GET', 'POST'])('%s /api/user/orchestrator-key', (method) => {
  it('mints a docs key: personal, fixed scope, daily Buzz limit, 30-day expiry', async () => {
    const before = Date.now();
    const result = await call({ method });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ key: 'plaintext-1', name: NAME, expiresAt: expect.any(String) });
    expect(keys).toHaveLength(1);
    const [row] = keys;
    expect(row).toMatchObject({ name: NAME, type: 'User', userId: USER_ID });
    expect(readApiKeyScope(row)).toBe(DOCS_API_KEY_SCOPE);
    expect(row.buzzLimit).toEqual([{ type: 'sliding', limit: 1000, window: 'day', unit: 1 }]);
    const ttl = row.expiresAt!.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(30 * DAY - 5000);
    expect(ttl).toBeLessThanOrEqual(30 * DAY + 5000);
    expect(new Date(result.body.expiresAt as string).getTime()).toBe(row.expiresAt!.getTime());
  });

  it('leaves the older System key for this host alone', async () => {
    keys.push(legacySystemKey());
    expect((await call({ method })).status).toBe(200);
    expect(keys.find((k) => k.id === 5)).toEqual(legacySystemKey());
  });

  it.each([
    ['no Origin', null],
    ['a local docs build', 'http://localhost:4184'],
    ['the main site', 'https://civitai.com'],
    ['a look-alike host', 'https://developer.civitai.com.example'],
  ])('refuses %s without minting or removing a key', async (_label, origin) => {
    keys.push(docsKey(10), docsKey(11));
    const result = await call({ method, origin });
    expect(result.status).toBe(403);
    expect(dbMock.dbWrite.apiKey.create).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.apiKey.deleteMany).not.toHaveBeenCalled();
    expect(keys.map((k) => k.id)).toEqual([10, 11]);
  });

  it('refuses a bearer credential, even from the docs origin', async () => {
    keys.push(docsKey(10), docsKey(11));
    const result = await call({ method, authorization: 'Bearer personal-full' });
    expect(result.status).toBe(403);
    expect(dbMock.dbWrite.apiKey.create).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.apiKey.deleteMany).not.toHaveBeenCalled();
    expect(keys.map((k) => k.id)).toEqual([10, 11]);
  });

  it('keeps two live docs keys per host: removes the expired and the oldest', async () => {
    keys.push(
      docsKey(9, { expiresAt: new Date(Date.now() - DAY) }),
      docsKey(10),
      docsKey(11),
      docsKey(12, { name: 'Developer docs (civitai.other)' })
    );
    expect((await call({ method })).status).toBe(200);
    expect(keys.map((k) => k.id).sort()).toEqual([100, 11, 12].sort());
    expect(revokeCivitaiUserTokens).toHaveBeenCalledWith({ userId: USER_ID });
  });

  it.each<[string, Partial<KeyRow>]>([
    ['full scope, no expiry', { tokenScope: Number(TokenScope.Full), expiresAt: null }],
    ['full scope, with an expiry', { tokenScope: Number(TokenScope.Full) }],
    ['the docs scope, no expiry', { expiresAt: null }],
    ['the docs scope, but System', { type: 'System' }],
  ])('never removes a key that only shares the docs name (%s)', async (_label, over) => {
    const lookAlikes = [docsKey(1, over), docsKey(1001, over)];
    keys.push(...lookAlikes.map((k) => ({ ...k })), docsKey(10), docsKey(11));
    expect((await call({ method })).status).toBe(200);
    expect(keys.filter((k) => k.id === 1 || k.id === 1001)).toEqual(lookAlikes);
    expect(keys.map((k) => k.id).sort()).toEqual([1, 1001, 100, 11].sort());
  });
});

describe('POST /api/user/orchestrator-key', () => {
  it.each(['', 'application/x-www-form-urlencoded', 'text/plain'])(
    'refuses Content-Type %j without minting',
    async (contentType) => {
      keys.push(docsKey(10), docsKey(11));
      const result = await call({ method: 'POST', contentType });
      expect(result.status).toBe(415);
      expect(dbMock.dbWrite.apiKey.create).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.apiKey.deleteMany).not.toHaveBeenCalled();
    }
  );

  it('accepts application/json with a charset', async () => {
    const result = await call({ method: 'POST', contentType: 'application/json; charset=utf-8' });
    expect(result.status).toBe(200);
  });
});

describe('account standing', () => {
  it.each<[string, Partial<Account>]>([
    ['banned', { bannedAt: new Date('2026-10-01') }],
    ['deleted', { deletedAt: new Date('2026-10-01') }],
  ])('refuses a %s account before any key is written', async (_label, closed) => {
    account = { ...account!, ...closed };
    const result = await call();
    expect(result.status).toBe(403);
    expect(result.body.message).toBe(RESTRICTED_ACCOUNT_MESSAGE);
    expect(dbMock.dbWrite.apiKey.create).not.toHaveBeenCalled();
  });

  it('refuses an account with no row', async () => {
    account = null;
    expect((await call()).status).toBe(403);
    expect(dbMock.dbWrite.apiKey.create).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<Account>]>([
    ['a ban', { bannedAt: new Date('2026-10-01') }],
    ['a deletion', { deletedAt: new Date('2026-10-01') }],
  ])('leaves no live key when %s commits during the insert', async (_label, closed) => {
    // A pre-existing key, which the ban's own revocation sees and expires.
    keys.push({
      id: 50,
      key: 'hash-other',
      name: 'other',
      userId: USER_ID,
      type: 'User',
      tokenScope: Number(TokenScope.Full),
      expiresAt: null,
    });
    duringInsert = async () => {
      account = { ...account!, ...closed };
      revokeVisibleKeys();
    };

    const result = await call();

    expect(result.status).toBe(403);
    expect(result.body.key).toBeUndefined();
    expect(keys.find((k) => k.name === NAME)).toBeDefined();
    expect(keys.filter(live)).toEqual([]);
  });
});

describe('expireGenerationCredentials (a mute)', () => {
  it('expires docs keys, not a personal key that only shares the docs name', async () => {
    const lookAlike = docsKey(1, { tokenScope: Number(TokenScope.Full), expiresAt: null });
    keys.push({ ...lookAlike }, docsKey(10), legacySystemKey());
    await expireGenerationCredentials(USER_ID);
    expect(keys.find((k) => k.id === 1)).toEqual(lookAlike);
    expect(live(keys.find((k) => k.id === 10)!)).toBe(false);
    expect(live(keys.find((k) => k.id === 5)!)).toBe(false);
  });
});

describe('Settings key names', () => {
  it.each(['Developer docs (civitai.com)', '  developer DOCS (anything', 'DEVELOPER DOCS ('])(
    'refuses the reserved docs prefix: %j',
    (name) => {
      expect(addApiKeyInputSchema.safeParse({ name }).success).toBe(false);
    }
  );

  it.each(['My docs key', 'Developer docs', 'Developer docs key'])('accepts %j', (name) => {
    expect(addApiKeyInputSchema.safeParse({ name }).success).toBe(true);
  });
});
