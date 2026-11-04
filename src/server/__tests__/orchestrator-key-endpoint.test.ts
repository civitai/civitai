import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AccountRestriction from '~/server/services/account-restriction.service';
import type * as ApiKeyPrincipalCache from '~/server/auth/api-key-principal-cache';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import type * as KeyGenerator from '~/server/utils/key-generator';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { RESTRICTED_ACCOUNT_MESSAGE } from '~/server/common/content-restriction';

// GET /api/user/orchestrator-key mints a long-lived System key, so it must hold to the same account
// standing rules as every other mint: read from the primary before the insert, and again after it.

const USER_ID = 4343;
const HOST = 'civitai.test';
const NAME = `orchestrator-key:${HOST}`;

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

type Account = { id: number; bannedAt: Date | null; deletedAt: Date | null };
type KeyRow = {
  id: number;
  key: string;
  name: string;
  userId: number;
  type: string;
  expiresAt: Date | null;
};
type KeyWhere = {
  AND?: KeyWhere[];
  userId?: number;
  name?: string;
  type?: string;
  id?: { in?: number[] };
};

let account: Account | null;
let keys: KeyRow[];
let nextId: number;
/** Runs inside the insert, before the new row is visible: a concurrent ban or deletion committing. */
let duringInsert: (() => Promise<void>) | null;

function matches(row: KeyRow, where: KeyWhere): boolean {
  if (where.AND && !where.AND.every((w) => matches(row, w))) return false;
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.name !== undefined && row.name !== where.name) return false;
  if (where.type !== undefined && row.type !== where.type) return false;
  if (where.id?.in && !where.id.in.includes(row.id)) return false;
  return true;
}

/** What a ban or deletion does to keys: expire every row it can see. */
function revokeVisibleKeys() {
  const now = new Date();
  for (const row of keys) if (!row.expiresAt || row.expiresAt > now) row.expiresAt = now;
}

const live = (row: KeyRow) => !row.expiresAt || row.expiresAt > new Date();

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
  dbMock.dbWrite.apiKey.findMany.mockImplementation((async ({ where }: { where: KeyWhere }) =>
    keys.filter((k) => matches(k, where))) as never);
  dbMock.dbWrite.apiKey.deleteMany.mockImplementation((async ({ where }: { where: KeyWhere }) => {
    const before = keys.length;
    keys = keys.filter((k) => !matches(k, where));
    return { count: before - keys.length };
  }) as never);
  dbMock.dbWrite.apiKey.updateMany.mockImplementation((async ({
    where,
    data,
  }: {
    where: KeyWhere;
    data: { expiresAt: Date };
  }) => {
    const hit = keys.filter((k) => matches(k, where));
    for (const k of hit) k.expiresAt = data.expiresAt;
    return { count: hit.length };
  }) as never);
}

function call() {
  const req = { method: 'GET', query: {}, headers: { host: `${HOST}:443` }, url: '/' };
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
  nextId = 1;
  minted.count = 0;
  duringInsert = null;
  installTables();
  getServerAuthSession.mockResolvedValue({ user: { id: USER_ID } });
});

describe('GET /api/user/orchestrator-key', () => {
  it('mints one live key for an account in good standing, replacing the old one', async () => {
    keys.push({
      id: 99,
      key: 'hash-old',
      name: NAME,
      userId: USER_ID,
      type: 'System',
      expiresAt: null,
    });
    nextId = 100;
    const result = await call();
    expect(result.status).toBe(200);
    expect(result.body.key).toEqual(expect.any(String));
    expect(keys).toEqual([
      expect.objectContaining({ name: NAME, type: 'System', userId: USER_ID, expiresAt: null }),
    ]);
    expect(keys[0].id).toBe(100);
  });

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
      expiresAt: null,
    });
    nextId = 51;
    duringInsert = async () => {
      account = { ...account!, ...closed };
      revokeVisibleKeys();
    };

    const result = await call();

    expect(result.status).toBe(403);
    expect(result.body.key).toBeUndefined();
    const inserted = keys.find((k) => k.name === NAME);
    expect(inserted).toBeDefined();
    expect(keys.filter(live)).toEqual([]);
  });
});
