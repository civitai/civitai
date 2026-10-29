import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as KeyGenerator from '~/server/utils/key-generator';

vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => key,
}));
const { getSessionUserById } = vi.hoisted(() => ({ getSessionUserById: vi.fn() }));
vi.mock('~/server/auth/session-client', () => ({ sessionClient: { getSessionUserById } }));

const { getSessionFromBearerToken } = await import('~/server/auth/bearer-token');

const USER_ID = 5;
const SYSTEM_META = { systemAccount: true };

/** The primary's view of the key owner; the session copy below is clean unless a test says otherwise. */
let owner: { isModerator: boolean; roles: string[] } | null;
let access: { app: string; roles: string[] }[];

beforeEach(() => {
  vi.clearAllMocks();
  installFakeCacheRedis();
  owner = { isModerator: false, roles: [] };
  access = [
    { app: 'moderator', roles: ['dispute-agent'] },
    { app: 'creator-studio', roles: ['partner'] },
  ];
  getSessionUserById.mockResolvedValue({
    id: USER_ID,
    isModerator: false,
    roles: [],
    meta: SYSTEM_META,
  });
  dbMock.dbWrite.apiKey.findFirst.mockResolvedValue({
    id: 77,
    userId: USER_ID,
    tokenScope: 1,
    lastUsedAt: new Date(),
    buzzLimit: null,
    clientId: null,
    type: 'User',
    expiresAt: null,
  } as never);
  dbMock.dbWrite.user.findUnique.mockImplementation(
    (async () =>
      owner && {
        isModerator: owner.isModerator,
        roles: owner.roles.map((role) => ({ role })),
      }) as never
  );
  dbMock.dbWrite.appPageAccess.findFirst.mockImplementation(
    (async ({ where }: { where: { app: string; roles: { hasSome: string[] } } }) =>
      access.find(
        (a) => a.app === where.app && a.roles.some((r) => where.roles.hasSome.includes(r))
      ) ?? null) as never
  );
});

describe('a bearer key owned by a system account', () => {
  it('authenticates while the account holds no moderator access', async () => {
    const session = await getSessionFromBearerToken('k');
    expect(session?.user.id).toBe(USER_ID);
  });

  it('authenticates with a role that only another app grants', async () => {
    owner = { isModerator: false, roles: ['partner'] };
    await expect(getSessionFromBearerToken('k')).resolves.not.toBeNull();
  });

  it.each([
    ['the moderator flag', { isModerator: true, roles: [] }],
    ['the moderator:admin role', { isModerator: false, roles: ['moderator:admin'] }],
    ['a role a moderator-app page grants', { isModerator: false, roles: ['dispute-agent'] }],
  ])('is refused once the account holds %s', async (_, held) => {
    owner = held;
    await expect(getSessionFromBearerToken('k')).resolves.toBeNull();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'system-account-bearer-refused', userId: USER_ID }),
      'auth'
    );
  });

  it.each([
    ['the moderator flag', { isModerator: true, roles: [] }],
    ['the moderator:admin role', { isModerator: false, roles: ['moderator:admin'] }],
    ['a role a moderator-app page grants', { isModerator: false, roles: ['dispute-agent'] }],
  ])('is refused while only the session copy still holds %s', async (_, held) => {
    getSessionUserById.mockResolvedValue({ id: USER_ID, meta: SYSTEM_META, ...held });
    await expect(getSessionFromBearerToken('k')).resolves.toBeNull();
  });

  it('is refused when the account row is gone', async () => {
    owner = null;
    await expect(getSessionFromBearerToken('k')).resolves.toBeNull();
  });

  it('is refused on a cached key row once access is granted', async () => {
    await expect(getSessionFromBearerToken('k')).resolves.not.toBeNull();
    owner = { isModerator: false, roles: ['dispute-agent'] };
    await expect(getSessionFromBearerToken('k')).resolves.toBeNull();
    expect(dbMock.dbWrite.apiKey.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('a bearer key owned by an ordinary account', () => {
  it('authenticates a moderator without reading the account row', async () => {
    getSessionUserById.mockResolvedValue({ id: USER_ID, isModerator: true, roles: [], meta: {} });
    await expect(getSessionFromBearerToken('k')).resolves.not.toBeNull();
    expect(dbMock.dbWrite.user.findUnique).not.toHaveBeenCalled();
  });
});
