import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { TokenScope, TokenScopePresets } from '~/shared/constants/token-scope.constants';
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

function keyOwnedBy(userId: number, tokenScope: number = TokenScope.UserRead) {
  dbMock.dbWrite.apiKey.findFirst.mockResolvedValue({
    id: 77,
    userId,
    tokenScope,
    lastUsedAt: new Date(),
    buzzLimit: null,
    clientId: null,
    type: 'User',
    expiresAt: null,
  } as never);
}

// Only this role is granted by a moderator-app page, so each other row must earn its refusal.
function pageAccessFor(role: string) {
  dbMock.dbWrite.appPageAccess.findFirst.mockImplementation((async (args: {
    where: { roles: { hasSome: string[] } };
  }) => (args.where.roles.hasSome.includes(role) ? { path: '/' } : null)) as never);
}

type Held = { isModerator: boolean; roles: readonly string[] };

// The account's own row on the primary.
function primaryHolds({ isModerator, roles }: Held, meta: unknown = SYSTEM_META) {
  dbMock.dbWrite.user.findUnique.mockResolvedValue({
    meta,
    isModerator,
    roles: roles.map((role) => ({ role })),
  } as never);
}

// The primary and the session copy agree.
function holds(held: Held) {
  primaryHolds(held);
  getSessionUserById.mockResolvedValue({ id: USER_ID, meta: SYSTEM_META, ...held });
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
  primaryHolds({ isModerator: false, roles: [] });
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
    // The mock answers any id, so the id it was asked for is what pins the key to its owner.
    expect(getSessionUserById).toHaveBeenCalledWith(USER_ID);
  });

  it.each(MODERATOR_ACCESS)('resolves to the account while it holds %s', async (_, held) => {
    holds(held);
    const session = await getSessionFromBearerToken('k');
    expect(session?.user.id).toBe(USER_ID);
    // The mock answers any id, so the id it was asked for is what pins the key to its owner.
    expect(getSessionUserById).toHaveBeenCalledWith(USER_ID);
  });

  it.each(MODERATOR_ACCESS)(
    'with every read scope resolves while the account holds %s',
    async (_, held) => {
      keyOwnedBy(USER_ID, TokenScopePresets.ReadOnly);
      pageAccessFor('dispute-agent');
      holds(held);
      await expect(getSessionFromBearerToken('k')).resolves.toMatchObject({
        user: { id: USER_ID },
      });
    }
  );

  describe('with a write scope', () => {
    beforeEach(() => {
      keyOwnedBy(USER_ID, TokenScope.UserRead | TokenScope.AIServicesWrite);
      pageAccessFor('dispute-agent');
    });

    it('resolves while the account holds no moderator access', async () => {
      holds({ isModerator: false, roles: ['some-other-role'] });
      await expect(getSessionFromBearerToken('k')).resolves.toMatchObject({
        user: { id: USER_ID },
      });
    });

    it('is refused when the primary has no row for the account', async () => {
      dbMock.dbWrite.user.findUnique.mockResolvedValue(null as never);
      await expect(getSessionFromBearerToken('k')).resolves.toBeNull();
      expect(dbMock.dbWrite.user.findUnique).toHaveBeenCalled();
    });

    // The session copy (beforeEach) still shows no access: a grant it has not caught up with counts.
    it.each(MODERATOR_ACCESS)('is refused while the account holds %s', async (_, held) => {
      primaryHolds(held);
      await expect(getSessionFromBearerToken('k')).resolves.toBeNull();
      expect(getSessionUserById).toHaveBeenCalledWith(USER_ID);
    });

    describe('once an admin has allowed it write keys', () => {
      const ALLOWED = { ...SYSTEM_META, moderatorWriteKeys: true };

      it.each(MODERATOR_ACCESS)(
        'resolves a Full key while the account holds %s',
        async (_, held) => {
          keyOwnedBy(USER_ID, TokenScope.Full);
          holds(held);
          primaryHolds(held, ALLOWED);
          await expect(getSessionFromBearerToken('k')).resolves.toMatchObject({
            user: { id: USER_ID },
          });
        }
      );

      it('resolves when the primary stores meta as a JSON string', async () => {
        holds({ isModerator: true, roles: [] });
        primaryHolds({ isModerator: true, roles: [] }, JSON.stringify(ALLOWED));
        await expect(getSessionFromBearerToken('k')).resolves.toMatchObject({
          user: { id: USER_ID },
        });
      });

      it('is refused when only the session copy carries the allowance', async () => {
        primaryHolds({ isModerator: true, roles: [] });
        getSessionUserById.mockResolvedValue({
          id: USER_ID,
          meta: ALLOWED,
          isModerator: true,
          roles: [],
        });
        await expect(getSessionFromBearerToken('k')).resolves.toBeNull();
      });

      it.each([
        ['the string "true"', 'true'],
        ['the number 1', 1],
        ['an object', {}],
      ])('is refused when the allowance is %s', async (_, value) => {
        holds({ isModerator: true, roles: [] });
        primaryHolds(
          { isModerator: true, roles: [] },
          { ...SYSTEM_META, moderatorWriteKeys: value }
        );
        await expect(getSessionFromBearerToken('k')).resolves.toBeNull();
      });

      it('is still refused once the account is banned', async () => {
        primaryHolds({ isModerator: true, roles: [] }, ALLOWED);
        getSessionUserById.mockResolvedValue({
          id: USER_ID,
          meta: ALLOWED,
          isModerator: true,
          roles: [],
          bannedAt: new Date(),
        });
        await expect(getSessionFromBearerToken('k')).resolves.toBeNull();
      });

      it('is still refused for the shared moderation account', async () => {
        keyOwnedBy(MODERATION, TokenScope.Full);
        primaryHolds({ isModerator: true, roles: [] }, ALLOWED);
        getSessionUserById.mockResolvedValue({
          id: MODERATION,
          meta: ALLOWED,
          isModerator: true,
          roles: [],
        });
        await expect(getSessionFromBearerToken('k')).resolves.toBeNull();
      });
    });

    // The allowance only lifts the system-account rule, so on any other account it changes nothing.
    it('owned by an ordinary banned account stays refused with the allowance', async () => {
      const meta = { moderatorWriteKeys: true };
      primaryHolds({ isModerator: true, roles: [] }, meta);
      getSessionUserById.mockResolvedValue({
        id: USER_ID,
        meta,
        isModerator: true,
        roles: [],
        bannedAt: new Date(),
      });
      await expect(getSessionFromBearerToken('k')).resolves.toBeNull();
    });

    it.each(MODERATOR_ACCESS)(
      'owned by an ordinary account resolves while it holds %s',
      async (_, held) => {
        primaryHolds(held);
        getSessionUserById.mockResolvedValue({ id: USER_ID, meta: {}, ...held });
        await expect(getSessionFromBearerToken('k')).resolves.toMatchObject({
          user: { id: USER_ID },
        });
      }
    );
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
    expect(getSessionUserById).toHaveBeenCalledWith(USER_ID);
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
    expect(getSessionUserById).toHaveBeenCalledWith(MODERATION);
  });
});
