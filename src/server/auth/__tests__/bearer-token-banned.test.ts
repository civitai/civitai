import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as KeyGenerator from '~/server/utils/key-generator';

vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => key,
}));
const { getSessionUserById } = vi.hoisted(() => ({ getSessionUserById: vi.fn() }));
vi.mock('~/server/auth/session-client', () => ({ sessionClient: { getSessionUserById } }));

const { getSessionFromBearerToken } = await import('~/server/auth/bearer-token');

beforeEach(() => {
  dbMock.dbWrite.apiKey.findFirst.mockResolvedValue({
    id: 77,
    userId: 5,
    tokenScope: 1,
    lastUsedAt: new Date(),
    buzzLimit: null,
    clientId: null,
    type: 'User',
  } as never);
});

describe('a bearer key of a banned account', () => {
  it('authenticates while the account is in good standing', async () => {
    getSessionUserById.mockResolvedValue({ id: 5, bannedAt: undefined });
    await expect(getSessionFromBearerToken('k')).resolves.not.toBeNull();
  });

  it('is refused once the account is banned, whatever the key row says', async () => {
    getSessionUserById.mockResolvedValue({ id: 5, bannedAt: new Date() });
    await expect(getSessionFromBearerToken('k')).resolves.toBeNull();
  });
});

// A key or OAuth token row the memorialization's revoke did not reach still authenticates no one.
describe('a bearer key of a memorialized account', () => {
  it('is refused once the session user carries the marker', async () => {
    getSessionUserById.mockResolvedValue({ id: 5, memorialized: true });
    await expect(getSessionFromBearerToken('k')).resolves.toBeNull();
  });
});
