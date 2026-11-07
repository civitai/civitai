import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as KeyGenerator from '~/server/utils/key-generator';
import type * as PrincipalCache from '~/server/auth/api-key-principal-cache';

const { mockReadCachedApiKey } = vi.hoisted(() => ({ mockReadCachedApiKey: vi.fn() }));

vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => `hash-of-${key}`,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: vi.fn(async (id: number) => ({ id, bannedAt: null })) },
}));
vi.mock('~/server/auth/api-key-principal-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof PrincipalCache>()),
  readCachedApiKey: mockReadCachedApiKey,
  cacheApiKey: vi.fn(),
  claimLastUsedWrite: vi.fn(async () => false),
}));

const { getSessionFromBearerToken } = await import('~/server/auth/bearer-token');
const { getServerAuthSession } = await import('~/server/auth/get-server-auth-session');

const KEY = 'presented-key-value-0123456789';
const row = (id: number) => ({
  id,
  userId: 5,
  tokenScope: 1,
  lastUsedAt: new Date(),
  buzzLimit: null,
  clientId: null,
  type: 'User',
  expiresAt: null,
});
const meterCalls = () =>
  loggingMock.logToAxiom.mock.calls
    .map(([payload]) => payload as Record<string, unknown>)
    .filter((payload) => payload.name === 'api-key-meter');

beforeEach(() => {
  loggingMock.logToAxiom.mockClear();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
  dbMock.dbWrite.apiKey.findFirst.mockReset();
  mockReadCachedApiKey.mockReset();
  mockReadCachedApiKey.mockResolvedValue({ apiKey: null, fill: false });
  setEnv({ AUTH_METER_API_KEY_IDS: ['77'] });
});

describe('API-key meter', () => {
  it('logs a metered key read from the database, by id, with the path but not the query', async () => {
    dbMock.dbWrite.apiKey.findFirst.mockResolvedValue(row(77));
    await getSessionFromBearerToken(KEY, {
      request: { method: 'GET', path: `/api/download/models/1?token=${KEY}` },
    });
    expect(meterCalls()).toEqual([
      expect.objectContaining({
        apiKeyId: 77,
        source: 'db',
        method: 'GET',
        path: '/api/download/models/1',
      }),
    ]);
    expect(JSON.stringify(meterCalls())).not.toContain(KEY);
  });

  it('logs a metered key served from the principal cache', async () => {
    mockReadCachedApiKey.mockResolvedValue({ apiKey: row(77), fill: false });
    await getSessionFromBearerToken(KEY);
    expect(meterCalls()).toEqual([expect.objectContaining({ apiKeyId: 77, source: 'cache' })]);
  });

  it('logs nothing for a key that is not metered', async () => {
    dbMock.dbWrite.apiKey.findFirst.mockResolvedValue(row(78));
    await getSessionFromBearerToken(KEY);
    expect(meterCalls()).toEqual([]);
  });

  describe('through getServerAuthSession', () => {
    const request = (url: string, headers: Record<string, string>) =>
      ({
        url,
        method: 'GET',
        headers,
        cookies: {},
        socket: { remoteAddress: '10.0.0.5' },
      } as never);
    const res = { setHeader: vi.fn(), getHeader: vi.fn() } as never;

    it('logs the edge-attested client IP, country and how the key was presented', async () => {
      dbMock.dbWrite.apiKey.findFirst.mockResolvedValue(row(77));
      await getServerAuthSession({
        req: request(`/api/download/models/1?token=${KEY}`, {
          'cf-ray': 'abc123-IAD',
          'cf-connecting-ip': '203.0.113.9',
          'cf-ipcountry': 'NL',
        }),
        res,
      });
      expect(meterCalls()).toEqual([
        expect.objectContaining({ apiKeyId: 77, ip: '203.0.113.9', country: 'NL', via: 'query' }),
      ]);
      expect(JSON.stringify(meterCalls())).not.toContain(KEY);
    });

    it('logs the transport peer, not a forwarded-for header the caller wrote', async () => {
      dbMock.dbWrite.apiKey.findFirst.mockResolvedValue(row(77));
      await getServerAuthSession({
        req: request('/api/v1/me', {
          authorization: `Bearer ${KEY}`,
          'x-forwarded-for': '198.51.100.1',
          // No cf-ray: a cf-connecting-ip the caller sent is not edge-attested.
          'cf-connecting-ip': '198.51.100.2',
        }),
        res,
      });
      expect(meterCalls()).toEqual([
        expect.objectContaining({ apiKeyId: 77, ip: '10.0.0.5', via: 'bearer' }),
      ]);
    });
  });
});
