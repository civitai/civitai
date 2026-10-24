import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ApiKeySpend from '~/server/http/orchestrator/api-key-spend';
import type * as KeyGenerator from '~/server/utils/key-generator';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type { SessionUser } from '~/types/session';

/**
 * `/api/v1/me` hands an API key's spend limit to the orchestrator, which caches it for its own TTL.
 * The bearer lookup that authenticated the request may have come from the short-lived principal
 * cache, so the limit it carries can be stale when an eviction failed. This pins the seam: after a
 * limit change whose eviction FAILED, the bearer path still serves the old row, and `/me` must
 * nevertheless return the new limit.
 */

vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => `hash-of-${key}`,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: vi.fn(async (id: number) => ({ id, bannedAt: null })) },
}));
vi.mock('~/server/http/orchestrator/api-key-spend', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeySpend>()),
  bustBuzzLimitCache: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  AuthedEndpoint: (handler: unknown) => handler,
}));

const { getSessionFromBearerToken } = await import('~/server/auth/bearer-token');
const { setApiKeyBuzzLimit } = await import('~/server/services/api-key.service');
const handler = (await import('~/pages/api/v1/me')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
) => Promise<void>;

type Row = {
  id: number;
  key: string;
  userId: number;
  tokenScope: number;
  lastUsedAt: Date;
  buzzLimit: { limit: number } | null;
  clientId: string | null;
  type: string;
  expiresAt: Date | null;
};
let rows: Row[];

/** Call `/me` the way get-server-auth-session would after a bearer lookup. */
async function me(session: Awaited<ReturnType<typeof getSessionFromBearerToken>>) {
  let status = 200;
  let body: Record<string, unknown> | undefined;
  const req = {
    method: 'GET',
    headers: {},
    query: {},
    context: {
      tokenScope: session?.tokenScope,
      buzzLimit: session?.buzzLimit ?? null,
      subject: session?.subject,
    },
  } as unknown as NextApiRequest;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: Record<string, unknown>) {
      body = value;
      return res;
    },
    send(value: Record<string, unknown>) {
      body = value;
      return res;
    },
  } as unknown as NextApiResponse;
  await handler(req, res, { id: 701, username: 'owner' } as SessionUser);
  return { status, body };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T12:00:00.000Z'));
  installFakeCacheRedis();
  rows = [
    {
      id: 71,
      key: 'hash-of-personal',
      userId: 701,
      tokenScope: 0b0101,
      lastUsedAt: new Date(),
      buzzLimit: { limit: 100 },
      clientId: null,
      type: 'User',
      expiresAt: null,
    },
  ];
  const find = (key: string) => rows.find((r) => r.key === key);
  dbMock.dbWrite.apiKey.findFirst.mockImplementation((async ({
    where,
  }: {
    where: { key: string };
  }) => {
    const row = find(where.key);
    return row ? { ...row } : null;
  }) as never);
  dbMock.dbWrite.apiKey.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => {
    const row = rows.find((r) => r.id === where.id);
    return row ? { buzzLimit: row.buzzLimit } : null;
  }) as never);
  dbMock.dbWrite.apiKey.update.mockImplementation((async ({
    where,
    data,
  }: {
    where: { id: number };
    data: Partial<Row>;
  }) => {
    const row = rows.find((r) => r.id === where.id)!;
    Object.assign(row, data);
    return { ...row };
  }) as never);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('/api/v1/me spend limit', () => {
  it('returns a lowered limit even when the bearer row cache could not be evicted', async () => {
    await getSessionFromBearerToken('personal'); // cache the row with limit 100
    // The tombstone write fails, so the cached row (limit 100) survives the change.
    redisMock.redis.packed.set.mockImplementation((() => {
      throw new Error('cache cluster down');
    }) as never);
    await setApiKeyBuzzLimit({ id: 71, userId: 701, buzzLimit: { limit: 9 } as never });
    const session = await getSessionFromBearerToken('personal');
    // Control: the bearer path itself is still serving the old row.
    expect(session?.buzzLimit).toEqual({ limit: 100 });
    const { status, body } = await me(session);
    expect(status).toBe(200);
    expect(body?.buzzLimit).toEqual({ limit: 9 });
  });

  it('refuses rather than report "no cap" for a key deleted mid-request', async () => {
    const session = await getSessionFromBearerToken('personal');
    rows = [];
    const { status, body } = await me(session);
    expect(status).toBe(401);
    expect(body).not.toHaveProperty('buzzLimit');
  });

  it('takes an OAuth subject’s limit from the request (its consent row is read per request)', async () => {
    const { body } = await me({
      tokenScope: 1,
      buzzLimit: { limit: 42 },
      subject: { type: 'oauth', id: 'client-1' },
    } as never);
    expect(body?.buzzLimit).toEqual({ limit: 42 });
    expect(dbMock.dbWrite.apiKey.findUnique).not.toHaveBeenCalled();
  });
});
