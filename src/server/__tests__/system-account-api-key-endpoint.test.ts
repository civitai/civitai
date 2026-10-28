import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '@civitai/auth/token-scope';
import type * as ApiKeyPrincipalCache from '~/server/auth/api-key-principal-cache';
import type * as ModeratorService from '~/server/services/moderator.service';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import type * as KeyGenerator from '~/server/utils/key-generator';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const TOKEN = 'test-system-account-key-token-00000';
const MODERATION_ID = 77;
const DAY_MS = 24 * 60 * 60 * 1000;

const { trackModActivity, evictCachedApiKeys, keys } = vi.hoisted(() => ({
  trackModActivity: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  evictCachedApiKeys: vi.fn<(hashes: string[]) => Promise<undefined>>(async () => undefined),
  keys: { minted: 0 },
}));

vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity,
}));
vi.mock('~/server/auth/api-key-principal-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyPrincipalCache>()),
  evictCachedApiKeys,
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateKey: () => `fake-plaintext-${++keys.minted}`,
  generateSecretHash: (key: string) => `fake-hash-of-${key}`,
}));

const logToAxiom = loggingMock.logToAxiom;
const handler = (await import('~/pages/api/admin/system-account-api-key')).default;

type UserRow = {
  id: number;
  username: string | null;
  meta: unknown;
  deletedAt: Date | null;
  bannedAt: Date | null;
  isModerator: boolean;
  roles: { role: string }[];
};
type KeyRow = {
  id: number;
  key: string;
  name: string;
  userId: number;
  type: string;
  tokenScope: number;
  expiresAt: Date | null;
};
type AccessRow = { app: string; path: string; roles: string[] };

let users: UserRow[];
let apiKeys: KeyRow[];
let access: AccessRow[];

const SYSTEM_ID = 1001;
const systemUser = (overrides: Partial<UserRow> = {}): UserRow => ({
  id: SYSTEM_ID,
  username: 'TestAgent',
  meta: { systemAccount: true },
  deletedAt: null,
  bannedAt: null,
  isModerator: false,
  roles: [],
  ...overrides,
});

type KeyWhere = {
  AND?: KeyWhere[];
  userId?: number;
  key?: string;
  name?: string;
  type?: string;
  id?: number | { not?: number; in?: number[]; lt?: number };
};
function matches(row: KeyRow, where: KeyWhere): boolean {
  if (where.AND && !where.AND.every((w) => matches(row, w))) return false;
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.key !== undefined && row.key !== where.key) return false;
  if (where.name !== undefined && row.name !== where.name) return false;
  if (where.type !== undefined && row.type !== where.type) return false;
  const id = where.id;
  if (typeof id === 'number') return row.id === id;
  if (id?.not !== undefined && row.id === id.not) return false;
  if (id?.in && !id.in.includes(row.id)) return false;
  if (id?.lt !== undefined && row.id >= id.lt) return false;
  return true;
}

function installTables() {
  dbMock.dbWrite.user.findUnique.mockImplementation(
    async ({ where }: { where: { id: number } }) => users.find((u) => u.id === where.id) ?? null
  );
  dbMock.dbWrite.apiKey.create.mockImplementation(async ({ data }: { data: KeyRow }) => {
    const row = { ...data, expiresAt: data.expiresAt ?? null, id: 500 + apiKeys.length };
    apiKeys.push(row);
    return row;
  });
  dbMock.dbWrite.apiKey.count.mockImplementation(
    async ({ where }: { where: KeyWhere }) => apiKeys.filter((k) => matches(k, where)).length
  );
  dbMock.dbWrite.apiKey.findUniqueOrThrow.mockImplementation(
    async ({ where }: { where: { key: string } }) => {
      const row = apiKeys.find((k) => k.key === where.key);
      if (!row) throw new Error('not found');
      return row;
    }
  );
  dbMock.dbWrite.apiKey.findMany.mockImplementation(async ({ where }: { where: KeyWhere }) =>
    apiKeys.filter((k) => matches(k, where))
  );
  dbMock.dbWrite.apiKey.deleteMany.mockImplementation(async ({ where }: { where: KeyWhere }) => {
    const before = apiKeys.length;
    apiKeys = apiKeys.filter((k) => !matches(k, where));
    return { count: before - apiKeys.length };
  });
  dbMock.dbWrite.appPageAccess.findFirst.mockImplementation(
    async ({ where }: { where: { app: string; roles: { hasSome: string[] } } }) =>
      access.find(
        (a) => a.app === where.app && a.roles.some((r) => where.roles.hasSome.includes(r))
      ) ?? null
  );
}

function call(
  body: Record<string, unknown>,
  {
    token = TOKEN as string | string[] | null,
    method = 'POST',
    query = {} as Record<string, string>,
    rawQuery = '',
  } = {}
) {
  const headers = token === null ? {} : { 'x-admin-token': token };
  const search = rawQuery || new URLSearchParams(query).toString();
  const url = `/api/admin/system-account-api-key${search ? `?${search}` : ''}`;
  const req = { method, query, body, headers, url };
  return send(req as unknown as NextApiRequest);
}

function send(req: NextApiRequest) {
  let statusCode = 0;
  let payload: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: Record<string, unknown>) {
      payload = data;
      return res;
    },
    send: () => res,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    end: () => res,
  };
  return (handler(req, res as unknown as NextApiResponse) as Promise<void>).then(() => ({
    status: statusCode,
    body: payload,
    headers,
  }));
}

beforeEach(() => {
  users = [systemUser()];
  apiKeys = [];
  access = [];
  keys.minted = 0;
  installTables();
  trackModActivity.mockClear();
  evictCachedApiKeys.mockClear();
  logToAxiom.mockClear();
  setEnv({ CIVITAI_MODERATION_USER_ID: String(MODERATION_ID), SYSTEM_ACCOUNT_KEY_TOKEN: TOKEN });
});

describe('POST /api/admin/system-account-api-key', () => {
  it('refuses a caller without the admin token, and admits the same request with it', async () => {
    expect((await call({ userId: SYSTEM_ID }, { token: 'wrong' })).status).toBe(401);
    expect((await call({ userId: SYSTEM_ID }, { token: null })).status).toBe(401);
    expect((await call({ userId: SYSTEM_ID }, { token: 'test-webhook-token' })).status).toBe(401);
    expect(apiKeys).toHaveLength(0);

    const admitted = await call({ userId: SYSTEM_ID });
    expect(admitted.status).toBe(201);
    expect(apiKeys).toHaveLength(1);
  });

  it('refuses the token in the query string, even when it is right', async () => {
    const { status } = await call({ userId: SYSTEM_ID }, { token: null, query: { token: TOKEN } });
    expect(status).toBe(400);
    const both = await call({ userId: SYSTEM_ID }, { query: { token: TOKEN } });
    expect(both.status).toBe(400);
    expect(apiKeys).toHaveLength(0);
  });

  it('refuses any query string, however it is spelled', async () => {
    for (const rawQuery of [`a=b?token=${TOKEN}`, `?token=${TOKEN}`, 'a=1']) {
      expect((await call({ userId: SYSTEM_ID }, { rawQuery })).status).toBe(400);
    }
    expect(apiKeys).toHaveLength(0);
  });

  it('refuses a repeated token header', async () => {
    expect((await call({ userId: SYSTEM_ID }, { token: [TOKEN, TOKEN] })).status).toBe(401);
  });

  it.each([
    ['unset', undefined],
    ['blank', '   '],
    ['too short to be a real secret', 'a'.repeat(31)],
    ['padded with spaces to length', `short${' '.repeat(27)}`],
    ['carrying a trailing newline', `${'a'.repeat(32)}\n`],
    ['carrying leading whitespace', ` ${'a'.repeat(32)}`],
  ])('is closed when its token is %s', async (_label, configured) => {
    setEnv({ SYSTEM_ACCOUNT_KEY_TOKEN: configured });
    const { status } = await call({ userId: SYSTEM_ID }, { token: configured ?? '' });
    expect(status).toBe(503);
    expect(apiKeys).toHaveLength(0);
  });

  it('mints a read-only User key that expires in a year, storing only its hash', async () => {
    const before = Date.now();
    const { status, body, headers } = await call({ userId: SYSTEM_ID });

    expect(status).toBe(201);
    expect(headers['cache-control']).toBe('no-store');
    expect(body.key).toBe('fake-plaintext-1');
    expect(apiKeys).toEqual([
      expect.objectContaining({
        userId: SYSTEM_ID,
        type: 'User',
        name: 'system',
        key: 'fake-hash-of-fake-plaintext-1',
        tokenScope: TokenScope.UserRead | TokenScope.ModelsRead | TokenScope.MediaRead,
      }),
    ]);
    const expiresIn = apiKeys[0].expiresAt!.getTime() - before;
    expect(expiresIn).toBeGreaterThanOrEqual(365 * DAY_MS - 1000);
    expect(expiresIn).toBeLessThanOrEqual(365 * DAY_MS + 1000);
    expect(body).toMatchObject({ userId: SYSTEM_ID, keyId: apiKeys[0].id, rotated: 0 });
  });

  it('grants exactly the named read scopes', async () => {
    const { status } = await call({ userId: SYSTEM_ID, scopes: ['UserRead', 'BuzzRead'] });
    expect(status).toBe(201);
    expect(apiKeys[0].tokenScope).toBe(TokenScope.UserRead | TokenScope.BuzzRead);
  });

  it.each([
    ['a write scope', ['UserRead', 'ModelsWrite']],
    ['Full', ['Full']],
    ['an opt-in scope', ['AppBlocksSubmit']],
    ['a tipping scope', ['SocialTip']],
    ['an unknown scope', ['Nope']],
    ['an inherited property name', ['toString']],
    ['an empty list', []],
  ])('refuses %s', async (_label, scopes) => {
    const { status } = await call({ userId: SYSTEM_ID, scopes });
    expect(status).toBe(400);
    expect(apiKeys).toHaveLength(0);
  });

  it('trims the key name, so a padded name rotates the same key', async () => {
    await call({ userId: SYSTEM_ID, name: 'ops' });
    const { body } = await call({ userId: SYSTEM_ID, name: '  ops  ' });
    expect(body.rotated).toBe(1);
    expect(apiKeys.map((k) => k.name)).toEqual(['ops']);
  });

  it.each([
    ['a name with spaces inside', 'two words'],
    ['a name over 64 characters', 'a'.repeat(65)],
    ['an empty name', '   '],
  ])('refuses %s', async (_label, name) => {
    expect((await call({ userId: SYSTEM_ID, name })).status).toBe(400);
    expect(apiKeys).toHaveLength(0);
  });

  it.each([
    ['empty', ''],
    ['null', null],
  ])('treats an %s actorUserId as absent', async (_label, actorUserId) => {
    expect((await call({ userId: SYSTEM_ID, actorUserId })).status).toBe(201);
    const alert = logToAxiom.mock.calls.find(
      ([data]) => (data as { name?: string }).name === 'system-account-api-key-minted'
    );
    expect(alert?.[0]).toMatchObject({ details: { asserted_actor: null } });
  });

  it('refuses an expiry past 365 days and accepts a shorter one', async () => {
    expect((await call({ userId: SYSTEM_ID, expiresInDays: 366 })).status).toBe(400);
    expect(apiKeys).toHaveLength(0);

    const before = Date.now();
    expect((await call({ userId: SYSTEM_ID, expiresInDays: 30 })).status).toBe(201);
    expect(apiKeys[0].expiresAt!.getTime() - before).toBeLessThanOrEqual(30 * DAY_MS + 1000);
  });

  it.each([
    ['an account that is not a system account', { meta: {} }, 403],
    ['a deleted system account', { deletedAt: new Date() }, 403],
    ['a banned system account', { bannedAt: new Date() }, 403],
    ['a moderator', { isModerator: true }, 403],
    ['the moderation account, by id', { id: MODERATION_ID }, 403],
    ['the moderation account, by username', { username: 'civitaimoderation' }, 403],
    ['an account with the moderator admin role', { roles: [{ role: 'moderator:admin' }] }, 403],
  ])('refuses %s', async (_label, overrides, expected) => {
    const user = systemUser(overrides);
    users = [user];
    const { status } = await call({ userId: user.id });
    expect(status).toBe(expected);
    expect(apiKeys).toHaveLength(0);
  });

  it('refuses the moderation account by username when its id is not configured', async () => {
    setEnv({ CIVITAI_MODERATION_USER_ID: '' });
    users = [systemUser({ username: 'CivitaiModeration' })];
    expect((await call({ userId: SYSTEM_ID })).status).toBe(403);
    expect(apiKeys).toHaveLength(0);
  });

  it('answers 404 for an account that does not exist', async () => {
    expect((await call({ userId: 4242 })).status).toBe(404);
  });

  it.each([
    ['a moderator-app permission grant', 'grant:creatorServices.reviewDispute'],
    ['moderator-app page access', '/disputes'],
  ])('refuses an account holding %s through a role', async (_label, path) => {
    users = [systemUser({ roles: [{ role: 'dispute-agent' }] })];
    access = [{ app: 'moderator', path, roles: ['dispute-agent'] }];
    expect((await call({ userId: SYSTEM_ID })).status).toBe(403);
    expect(apiKeys).toHaveLength(0);
  });

  it('mints for an account whose roles grant nothing in the moderator app', async () => {
    users = [systemUser({ roles: [{ role: 'dispute-agent' }] })];
    access = [
      { app: 'moderator', path: 'grant:user.ban', roles: ['senior'] },
      { app: 'creator-studio', path: '/x', roles: ['dispute-agent'] },
    ];
    expect((await call({ userId: SYSTEM_ID })).status).toBe(201);
  });

  it('accepts a secret of exactly 32 characters', async () => {
    setEnv({ SYSTEM_ACCOUNT_KEY_TOKEN: 'a'.repeat(32) });
    expect((await call({ userId: SYSTEM_ID }, { token: 'a'.repeat(32) })).status).toBe(201);
  });

  it("rotation leaves other accounts' keys and other key types alone", async () => {
    users = [systemUser(), systemUser({ id: SYSTEM_ID + 1 })];
    const seed = (id: number, userId: number, type: string) =>
      apiKeys.push({
        id,
        key: `fake-hash-of-seed-${id}`,
        name: 'system',
        userId,
        type,
        tokenScope: 1,
        expiresAt: null,
      });
    seed(1, SYSTEM_ID + 1, 'User');
    seed(2, SYSTEM_ID, 'Access');
    const { body } = await call({ userId: SYSTEM_ID });
    expect(body.rotated).toBe(0);
    expect(apiKeys.map((k) => k.id).sort()).toEqual([1, 2, body.keyId]);
  });

  it('rotates: a second mint under the same name revokes the first, another name does not', async () => {
    await call({ userId: SYSTEM_ID });
    const other = await call({ userId: SYSTEM_ID, name: 'other' });
    expect(other.body.rotated).toBe(0);

    const second = await call({ userId: SYSTEM_ID });
    expect(second.status).toBe(201);
    expect(second.body.rotated).toBe(1);
    expect(second.body.key).toBe('fake-plaintext-3');
    expect(apiKeys.map((k) => k.key).sort()).toEqual([
      'fake-hash-of-fake-plaintext-2',
      'fake-hash-of-fake-plaintext-3',
    ]);
    expect(evictCachedApiKeys).toHaveBeenCalledWith(['fake-hash-of-fake-plaintext-1']);
  });

  it('leaves a newer key under the same name alone, so the later of two concurrent mints keeps its key', async () => {
    apiKeys.push({
      id: 9999,
      key: 'fake-hash-of-concurrent',
      name: 'system',
      userId: SYSTEM_ID,
      type: 'User',
      tokenScope: 1,
      expiresAt: null,
    });
    const { body } = await call({ userId: SYSTEM_ID });
    expect(body.rotated).toBe(0);
    expect(apiKeys.map((k) => k.id)).toContain(9999);
  });

  it('revokes the new key when the account gains moderator access while it is minted', async () => {
    dbMock.dbWrite.apiKey.create.mockImplementationOnce(async ({ data }: { data: KeyRow }) => {
      users = [systemUser({ isModerator: true })];
      const row = { ...data, expiresAt: data.expiresAt ?? null, id: 600 };
      apiKeys.push(row);
      return row;
    });
    apiKeys.push({
      id: 1,
      key: 'fake-hash-of-older',
      name: 'system',
      userId: SYSTEM_ID,
      type: 'User',
      tokenScope: 1,
      expiresAt: null,
    });
    const { status, body } = await call({ userId: SYSTEM_ID });
    expect(status).toBe(403);
    expect(body.key).toBeUndefined();
    expect(apiKeys.map((k) => k.id)).toEqual([1]);
  });

  it('revokes a key whose insert committed but reported failure, without rethrowing its error', async () => {
    dbMock.dbWrite.apiKey.create.mockImplementationOnce(async ({ data }: { data: KeyRow }) => {
      apiKeys.push({ ...data, expiresAt: data.expiresAt ?? null, id: 600 });
      throw new Error(`connection reset during insert of ${data.key}`);
    });
    const error = await call({ userId: SYSTEM_ID }).then(
      () => null,
      (e: Error) => e
    );
    expect(error?.message).toMatch(/System account key issue failed/);
    expect(error?.message).not.toContain('fake-hash-of');
    expect(apiKeys).toHaveLength(0);
    expect(trackModActivity).toHaveBeenCalledTimes(1);
  });

  const alertNames = () => logToAxiom.mock.calls.map(([data]) => (data as { name?: string }).name);

  it('keeps the new key when rotation fails, and reports the failed rotation', async () => {
    apiKeys.push({
      id: 1,
      key: 'fake-hash-of-older',
      name: 'system',
      userId: SYSTEM_ID,
      type: 'User',
      tokenScope: 1,
      expiresAt: null,
    });
    dbMock.dbWrite.apiKey.deleteMany.mockRejectedValueOnce(new Error('rotation failed'));
    const { status, body } = await call({ userId: SYSTEM_ID });
    expect(status).toBe(201);
    expect(body.rotated).toBeNull();
    expect(apiKeys.map((k) => k.id).sort()).toEqual([1, body.keyId]);
    expect(alertNames()).toContain('system-account-api-key-rotation-failed');
    expect(alertNames().some((n) => n?.includes('revoke'))).toBe(false);
  });

  it('reports a revoke that could not remove the key', async () => {
    dbMock.dbWrite.apiKey.findUniqueOrThrow.mockRejectedValueOnce(new Error('primary blip'));
    dbMock.dbWrite.apiKey.deleteMany.mockRejectedValue(new Error('delete failed'));
    await expect(call({ userId: SYSTEM_ID })).rejects.toThrow('System account key issue failed');
    expect(apiKeys).toHaveLength(1);
    expect(alertNames()).toContain('system-account-api-key-revoke-failed');
    expect(alertNames()).not.toContain('system-account-api-key-revoked');
  });

  it('never reports a key from a failed insert as revoked, since the insert may still commit', async () => {
    dbMock.dbWrite.apiKey.create.mockRejectedValueOnce(new Error('statement timeout'));
    await expect(call({ userId: SYSTEM_ID })).rejects.toThrow('System account key issue failed');
    expect(alertNames()).toContain('system-account-api-key-revoke-unconfirmed');
    expect(alertNames()).not.toContain('system-account-api-key-revoked');
  });

  it('reports a revoke it could not confirm as failed', async () => {
    dbMock.dbWrite.apiKey.findUniqueOrThrow.mockRejectedValueOnce(new Error('primary blip'));
    dbMock.dbWrite.apiKey.count.mockRejectedValueOnce(new Error('count failed'));
    await expect(call({ userId: SYSTEM_ID })).rejects.toThrow('System account key issue failed');
    expect(alertNames()).toContain('system-account-api-key-revoke-failed');
    expect(alertNames()).not.toContain('system-account-api-key-revoked');
  });

  it('counts a revoke as done when the row is gone even if cache eviction fails', async () => {
    dbMock.dbWrite.apiKey.create.mockImplementationOnce(async ({ data }: { data: KeyRow }) => {
      users = [systemUser({ isModerator: true })];
      apiKeys.push({ ...data, expiresAt: data.expiresAt ?? null, id: 600 });
      return apiKeys[0];
    });
    evictCachedApiKeys.mockRejectedValueOnce(new Error('redis down'));
    expect((await call({ userId: SYSTEM_ID })).status).toBe(403);
    expect(apiKeys).toHaveLength(0);
    expect(alertNames()).toContain('system-account-api-key-revoked');
    expect(alertNames()).not.toContain('system-account-api-key-revoke-failed');
  });

  it('still refuses with 403, and alerts, when revoking the refused key fails', async () => {
    dbMock.dbWrite.apiKey.create.mockImplementationOnce(async ({ data }: { data: KeyRow }) => {
      users = [systemUser({ isModerator: true })];
      const row = { ...data, expiresAt: data.expiresAt ?? null, id: 600 };
      apiKeys.push(row);
      return row;
    });
    dbMock.dbWrite.apiKey.deleteMany.mockRejectedValueOnce(new Error('delete failed'));
    const { status } = await call({ userId: SYSTEM_ID });
    expect(status).toBe(403);
    const names = logToAxiom.mock.calls.map(([data]) => (data as { name?: string }).name);
    expect(names).toContain('system-account-api-key-revoke-failed');
    expect(names).not.toContain('system-account-api-key-revoked');
  });

  it('revokes the new key when the re-check after the insert fails, and keeps older ones', async () => {
    apiKeys.push({
      id: 1,
      key: 'fake-hash-of-older',
      name: 'system',
      userId: SYSTEM_ID,
      type: 'User',
      tokenScope: 1,
      expiresAt: null,
    });
    dbMock.dbWrite.user.findUnique
      .mockImplementationOnce(async () => users[0])
      .mockRejectedValueOnce(new Error('read failed'));
    await expect(call({ userId: SYSTEM_ID })).rejects.toThrow('System account key issue failed');
    expect(apiKeys.map((k) => k.id)).toEqual([1]);
    expect(
      logToAxiom.mock.calls.some(
        ([data]) => (data as { name?: string }).name === 'system-account-api-key-revoked'
      )
    ).toBe(true);
  });

  it('audits, alerts and revokes a key that was inserted when the request then fails', async () => {
    dbMock.dbWrite.apiKey.findUniqueOrThrow.mockRejectedValueOnce(new Error('primary blip'));
    await expect(call({ userId: SYSTEM_ID })).rejects.toThrow('System account key issue failed');

    expect(apiKeys).toHaveLength(0);
    expect(trackModActivity).toHaveBeenCalledTimes(1);
    expect(
      logToAxiom.mock.calls.some(
        ([data]) => (data as { name?: string }).name === 'system-account-api-key-minted'
      )
    ).toBe(true);
  });

  it('audits and alerts on every mint, with neither the key nor its hash', async () => {
    await call({ userId: SYSTEM_ID, actorUserId: 9 });
    await call({ userId: SYSTEM_ID, actorUserId: 9 });

    expect(trackModActivity).toHaveBeenCalledTimes(2);
    expect(trackModActivity).toHaveBeenCalledWith(-1, {
      entityType: 'user',
      activity: 'mintSystemAccountApiKey',
      entityId: SYSTEM_ID,
    });
    const alerts = logToAxiom.mock.calls.filter(
      ([data]) => (data as { name?: string }).name === 'system-account-api-key-minted'
    );
    expect(alerts).toHaveLength(2);
    expect(alerts.every(([data]) => (data as { type: string }).type === 'error')).toBe(true);
    expect(alerts[0][0]).toMatchObject({ details: { asserted_actor: 9 } });
    expect(JSON.stringify(alerts)).not.toContain('actorUserId');

    const recorded = JSON.stringify([trackModActivity.mock.calls, logToAxiom.mock.calls]);
    expect(recorded).not.toContain('fake-plaintext');
    expect(recorded).not.toContain('fake-hash-of');
  });

  it('refuses any method but POST', async () => {
    expect((await call({ userId: SYSTEM_ID }, { method: 'GET' })).status).toBe(405);
    expect(apiKeys).toHaveLength(0);
  });
});
