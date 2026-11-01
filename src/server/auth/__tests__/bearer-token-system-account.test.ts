import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import type * as KeyGenerator from '~/server/utils/key-generator';

vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => key,
}));
const { getSessionUserById } = vi.hoisted(() => ({ getSessionUserById: vi.fn() }));
vi.mock('~/server/auth/session-client', () => ({ sessionClient: { getSessionUserById } }));

const { getSessionFromBearerToken } = await import('~/server/auth/bearer-token');

const USER_ID = 5;
const MODERATION = 900;
const SYSTEM_META = { systemAccount: true };

function keyOwnedBy(userId: number) {
  dbMock.dbWrite.apiKey.findFirst.mockResolvedValue({
    id: 77,
    userId,
    tokenScope: 1,
    lastUsedAt: new Date(),
    buzzLimit: null,
    clientId: null,
    type: 'User',
    expiresAt: null,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  installFakeCacheRedis();
  setEnv({ CIVITAI_MODERATION_USER_ID: MODERATION });
  getSessionUserById.mockResolvedValue({
    id: USER_ID,
    isModerator: false,
    roles: [],
    meta: SYSTEM_META,
  });
  keyOwnedBy(USER_ID);
});

const MODERATOR_ACCESS = [
  ['the moderator flag', { isModerator: true, roles: [] }],
  ['the moderator:admin role', { isModerator: false, roles: ['moderator:admin'] }],
  ['a role a moderator-app page grants', { isModerator: false, roles: ['dispute-agent'] }],
] as const;

describe('a bearer key owned by a system account', () => {
  it('resolves to the account while it holds no moderator access', async () => {
    const session = await getSessionFromBearerToken('k');
    expect(session?.user.id).toBe(USER_ID);
  });

  it.each(MODERATOR_ACCESS)('resolves to the account while it holds %s', async (_, held) => {
    getSessionUserById.mockResolvedValue({ id: USER_ID, meta: SYSTEM_META, ...held });
    const session = await getSessionFromBearerToken('k');
    expect(session?.user.id).toBe(USER_ID);
  });

  it('is refused once the account is banned', async () => {
    getSessionUserById.mockResolvedValue({
      id: USER_ID,
      meta: SYSTEM_META,
      isModerator: true,
      roles: [],
      bannedAt: new Date(),
    });
    await expect(getSessionFromBearerToken('k')).resolves.toBeNull();
  });

  it('is refused when it is the shared moderation account', async () => {
    keyOwnedBy(MODERATION);
    getSessionUserById.mockResolvedValue({
      id: MODERATION,
      meta: SYSTEM_META,
      isModerator: true,
      roles: [],
    });
    await expect(getSessionFromBearerToken('k')).resolves.toBeNull();
  });
});
