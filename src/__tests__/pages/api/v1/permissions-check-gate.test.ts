import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import type * as CommonService from '~/server/services/common.service';
import type * as KeyGenerator from '~/server/utils/key-generator';
import {
  CLIENT_CREDENTIALS_ONLY_SCOPES,
  TokenScope,
} from '~/shared/constants/token-scope.constants';

// The caller is resolved by the real session and bearer-key code; only storage is faked.
const { mockHasEntityAccess, getSessionUserById } = vi.hoisted(() => ({
  mockHasEntityAccess: vi.fn(),
  getSessionUserById: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PublicEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommonService>()),
  hasEntityAccess: mockHasEntityAccess,
}));
vi.mock('~/server/auth/session-client', () => ({ sessionClient: { getSessionUserById } }));
vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => key,
}));

import permissionsHandler from '~/pages/api/v1/permissions/check';

const VERSION = 100;
const ASKED = 7;
const OTHER = 8;
const SERVICE = -1;

type Owner = { id: number; isModerator?: boolean; bannedAt?: Date; meta?: unknown };
let users: Record<number, Owner> = {};

function keyFor(owner: Owner, tokenScope: number = TokenScope.ModelsRead) {
  users[owner.id] = owner;
  dbMock.dbWrite.apiKey.findFirst.mockResolvedValue({
    id: 1,
    userId: owner.id,
    tokenScope,
    lastUsedAt: new Date(),
    buzzLimit: null,
    clientId: null,
    type: 'System',
    expiresAt: null,
  } as never);
}

async function ask(authorization?: string) {
  const req = {
    method: 'GET',
    headers: authorization ? { authorization } : {},
    cookies: {},
    query: { entityIds: String(VERSION), userId: String(ASKED) },
  };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    getHeader: vi.fn(),
  };
  await permissionsHandler(req as never, res as never);
  lastRes = res;
  return res.json.mock.calls.at(-1)?.[0];
}
let lastRes: { setHeader: ReturnType<typeof vi.fn> };
const cacheHeader = () =>
  lastRes.setHeader.mock.calls.filter(([name]) => name === 'Cache-Control').at(-1)?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  installFakeCacheRedis();
  users = { [ASKED]: { id: ASKED } };
  getSessionUserById.mockImplementation(async (id: number) =>
    users[id] ? { roles: [], ...users[id] } : null
  );
  // Only the asked-about user holds access, so `true` means the gate let the question through.
  mockHasEntityAccess.mockImplementation(async ({ userId }: { userId?: number }) => [
    { entityId: VERSION, hasAccess: userId === ASKED },
  ]);
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.apiKey.findFirst.mockResolvedValue(null as never);
  setEnv({ PERMISSIONS_CHECK_GATE: true, PERMISSIONS_CHECK_SERVICE_USER_IDS: [SERVICE] });
});

describe('GET /api/v1/permissions/check with PERMISSIONS_CHECK_GATE', () => {
  it('answers about the given user for anyone while the switch is off', async () => {
    setEnv({ PERMISSIONS_CHECK_GATE: false });
    expect(await ask()).toEqual({ [VERSION]: true });
  });

  it('answers without the user for a caller with no credential, kept out of shared caches', async () => {
    expect(await ask()).toEqual({ [VERSION]: false });
    expect(cacheHeader()).toBe('private, no-store');
    expect(mockHasEntityAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: undefined })
    );
  });

  it('answers without the user for another user', async () => {
    keyFor({ id: OTHER });
    expect(await ask('Bearer k')).toEqual({ [VERSION]: false });
  });

  it('answers a user asking about themself', async () => {
    keyFor({ id: ASKED });
    expect(await ask('Bearer k')).toEqual({ [VERSION]: true });
    expect(cacheHeader()).toBe('private, no-store');
  });

  it('answers a listed account without the moderator flag', async () => {
    keyFor({ id: SERVICE });
    expect(await ask('Bearer k')).toEqual({ [VERSION]: true });
  });

  it('answers a read-only key owned by a listed system account', async () => {
    keyFor({ id: SERVICE, meta: { systemAccount: true } });
    expect(await ask('Bearer k')).toEqual({ [VERSION]: true });
  });

  it('answers a moderator who is not listed', async () => {
    keyFor({ id: OTHER, isModerator: true });
    expect(await ask('Bearer k')).toEqual({ [VERSION]: true });
  });

  it('answers without the user for a client-credentials token, as session auth refuses it', async () => {
    keyFor({ id: SERVICE }, CLIENT_CREDENTIALS_ONLY_SCOPES);
    expect(await ask('Bearer k')).toEqual({ [VERSION]: false });
  });

  it('answers without the user for a banned owner', async () => {
    keyFor({ id: SERVICE, bannedAt: new Date() });
    expect(await ask('Bearer k')).toEqual({ [VERSION]: false });
  });

  it('answers without the user for a key that resolves to nobody', async () => {
    expect(await ask('Bearer nope')).toEqual({ [VERSION]: false });
  });
});
