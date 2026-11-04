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
const LOG_NAME = 'permissions-check-untrusted-caller';

function keyOwnedBy(id: number, apiKeyType = 'User') {
  return { user: { id }, apiKeyId: 55, apiKeyType, subject: { type: 'apiKey', id: 55 } };
}

async function check(authorization?: string) {
  const req = {
    method: 'GET',
    headers: authorization ? { authorization } : {},
    query: { entityIds: String(VERSION), userId: String(ASKED_ABOUT) },
  };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await permissionsHandler(req as never, res as never);
  return res.json.mock.calls.at(-1)?.[0];
}

const logged = () =>
  loggingMock.logToAxiom.mock.calls
    .map(([entry]) => entry as Record<string, unknown>)
    .filter((entry) => entry.name === LOG_NAME);

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({ PERMISSIONS_CHECK_SERVICE_USER_IDS: [SERVICE_ID] });
  mockGetSessionUserById.mockResolvedValue({ id: ASKED_ABOUT });
  mockHasEntityAccess.mockResolvedValue([{ entityId: VERSION, hasAccess: true }]);
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([] as never);
});

describe('GET /api/v1/permissions/check, caller logging', () => {
  it('logs an anonymous caller without ids and still answers', async () => {
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

  it('logs the caller and key ids when another user asks', async () => {
    mockBearer.mockResolvedValue(keyOwnedBy(ASKED_ABOUT + 1));
    expect(await check('Bearer k')).toEqual({ [VERSION]: true });
    expect(logged()).toEqual([
      expect.objectContaining({
        caller: 'other-user',
        callerUserId: ASKED_ABOUT + 1,
        apiKeyId: 55,
      }),
    ]);
    expect(JSON.stringify(logged())).not.toContain('"k"');
  });

  // Every user who generates holds a System key, so the key type must not make a caller trusted.
  it('treats a System key owned by an unlisted user as untrusted', async () => {
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

  it('still answers when the bearer lookup throws', async () => {
    mockBearer.mockRejectedValue(new Error('db down'));
    expect(await check('Bearer k')).toEqual({ [VERSION]: true });
  });
});
