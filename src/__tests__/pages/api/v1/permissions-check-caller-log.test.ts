import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as CommonService from '~/server/services/common.service';

const { mockHasEntityAccess, mockGetSessionUserById, mockBearer } = vi.hoisted(() => ({
  mockHasEntityAccess: vi.fn(),
  mockGetSessionUserById: vi.fn(),
  mockBearer: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PublicEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommonService>()),
  hasEntityAccess: mockHasEntityAccess,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: mockGetSessionUserById },
}));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: mockBearer }));

import permissionsHandler from '~/pages/api/v1/permissions/check';

const SERVICE_ID = 900;
const ASKED_ABOUT = 7;
const VERSION = 100;
const LOG_NAME = 'permissions-check-caller';
let minute = 0;

function keyOwnedBy(id: number, apiKeyType = 'User') {
  return { user: { id }, apiKeyId: 55, apiKeyType, subject: { type: 'apiKey', id: 55 } };
}

async function check(authorization?: string, query: Record<string, string> = {}) {
  const req = {
    method: 'GET',
    headers: authorization ? { authorization } : {},
    query: { entityIds: String(VERSION), userId: String(ASKED_ABOUT), ...query },
  };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await permissionsHandler(req as never, res as never);
  // The log is written after the answer; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return res.json.mock.calls.at(-1)?.[0];
}

const logged = () =>
  loggingMock.logToAxiom.mock.calls
    .map(([entry]) => entry as Record<string, unknown>)
    .filter((entry) => entry.name === LOG_NAME);

beforeEach(() => {
  vi.clearAllMocks();
  mockBearer.mockReset();
  // A fresh minute per test, so the per-minute lookup budget starts full.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(++minute * 60_000);
  setEnv({ PERMISSIONS_CHECK_SERVICE_USER_IDS: [SERVICE_ID], WEBHOOK_TOKEN_PREVIOUS: 'old-hook' });
  mockGetSessionUserById.mockResolvedValue({ id: ASKED_ABOUT });
  mockHasEntityAccess.mockResolvedValue([{ entityId: VERSION, hasAccess: true }]);
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([] as never);
});

describe('GET /api/v1/permissions/check, caller logging', () => {
  it('logs an anonymous caller without ids', async () => {
    expect(await check()).toEqual({ [VERSION]: true });
    expect(logged()).toEqual([expect.objectContaining({ caller: 'anonymous' })]);
    expect(logged()[0]).not.toHaveProperty('callerUserId');
  });

  it('logs a bearer that resolves to nobody without ids', async () => {
    mockBearer.mockResolvedValue(null);
    expect(await check('Bearer nope')).toEqual({ [VERSION]: true });
    expect(logged()).toEqual([expect.objectContaining({ caller: 'unresolved-bearer' })]);
    expect(logged()[0]).not.toHaveProperty('apiKeyId');
  });

  it('logs the caller and key ids for another user', async () => {
    mockBearer.mockResolvedValue(keyOwnedBy(ASKED_ABOUT + 1));
    expect(await check('Bearer k')).toEqual({ [VERSION]: true });
    expect(logged()).toEqual([
      {
        type: 'info',
        name: LOG_NAME,
        caller: 'other-user',
        credentialSource: 'header',
        entityCount: 1,
        callerUserId: ASKED_ABOUT + 1,
        apiKeyId: 55,
        apiKeyType: 'User',
      },
    ]);
  });

  it('logs a System key owned by an unlisted user', async () => {
    mockBearer.mockResolvedValue(keyOwnedBy(ASKED_ABOUT + 1, 'System'));
    await check('Bearer k');
    expect(logged()).toEqual([
      expect.objectContaining({ caller: 'other-user', apiKeyType: 'System' }),
    ]);
  });

  it('does not log a listed service caller', async () => {
    mockBearer.mockResolvedValue(keyOwnedBy(SERVICE_ID));
    expect(await check('Bearer k')).toEqual({ [VERSION]: true });
    expect(logged()).toEqual([]);
  });

  it('does not log a caller asking about themself', async () => {
    mockBearer.mockResolvedValue(keyOwnedBy(ASKED_ABOUT));
    await check('Bearer k');
    expect(logged()).toEqual([]);
  });

  it('answers and logs when the bearer lookup throws', async () => {
    mockBearer.mockRejectedValue(new Error('db down'));
    expect(await check('Bearer k')).toEqual({ [VERSION]: true });
    expect(logged()).toEqual([expect.objectContaining({ caller: 'unresolved-bearer' })]);
  });

  it('reads a query-string token', async () => {
    mockBearer.mockResolvedValue(keyOwnedBy(SERVICE_ID));
    await check(undefined, { token: 'k' });
    expect(mockBearer).toHaveBeenCalledWith('k', { allowClientCredentialsOnly: true });
    expect(logged()).toEqual([]);
  });

  it('logs the source of a query-string token from an unlisted user', async () => {
    mockBearer.mockResolvedValue(keyOwnedBy(ASKED_ABOUT + 1));
    await check(undefined, { token: 'k' });
    expect(logged()).toEqual([
      expect.objectContaining({ caller: 'other-user', credentialSource: 'query' }),
    ]);
  });

  it('reads the first of repeated query tokens', async () => {
    mockBearer.mockResolvedValue(keyOwnedBy(SERVICE_ID));
    await check(undefined, { token: ['k', 'x'] as never });
    expect(mockBearer).toHaveBeenCalledWith('k', { allowClientCredentialsOnly: true });
  });

  it('never looks up the previous webhook token', async () => {
    await check(undefined, { token: 'old-hook' });
    expect(mockBearer).not.toHaveBeenCalled();
    expect(logged()).toEqual([
      expect.objectContaining({ caller: 'anonymous', credentialSource: 'none' }),
    ]);
  });

  it('answers without waiting for the caller lookup', async () => {
    mockBearer.mockReturnValue(new Promise(() => undefined));
    const late = new Promise((resolve) =>
      setTimeout(() => resolve('still waiting after 1s'), 1000)
    );
    expect(await Promise.race([check('Bearer k'), late])).toEqual({ [VERSION]: true });
  });

  it('logs at most 60 callers a minute, and keeps answering', async () => {
    for (let i = 0; i < 60; i++) await check();
    expect(await check()).toEqual({ [VERSION]: true });
    expect(logged()).toHaveLength(60);

    vi.setSystemTime(++minute * 60_000);
    await check();
    expect(logged()).toHaveLength(61);
  });

  it('does not spend the log cap on a listed service', async () => {
    mockBearer.mockResolvedValue(keyOwnedBy(SERVICE_ID));
    for (let i = 0; i < 100; i++) await check('Bearer k');
    await check();
    expect(logged()).toHaveLength(1);
  });

  it('stops looking up callers past 600 a minute, and keeps answering', async () => {
    mockBearer.mockResolvedValue(keyOwnedBy(SERVICE_ID));
    for (let i = 0; i < 600; i++) await check('Bearer k');
    expect(mockBearer).toHaveBeenCalledTimes(600);
    expect(await check('Bearer k')).toEqual({ [VERSION]: true });
    expect(mockBearer).toHaveBeenCalledTimes(600);
  });
});
