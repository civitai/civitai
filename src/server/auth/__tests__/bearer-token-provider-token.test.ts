import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as KeyGenerator from '~/server/utils/key-generator';

// A per-provider download token is accepted by the download route alone. Everywhere else it reaches
// the API-key lookup (as `?token=` or a bearer header) and must stand for no session, even if a key
// row with its hash existed.

vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => key,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: vi.fn(async (id: number) => ({ id, bannedAt: null })) },
}));

const { getSessionFromBearerToken } = await import('~/server/auth/bearer-token');

beforeEach(() => {
  dbMock.dbWrite.apiKey.findFirst.mockReset().mockResolvedValue({
    id: 77,
    userId: 5,
    tokenScope: 1,
    lastUsedAt: new Date(),
    buzzLimit: null,
    clientId: null,
    type: 'User',
  });
});

describe('a per-provider download token outside the download route', () => {
  it('resolves no session and is never looked up', async () => {
    expect(await getSessionFromBearerToken(`RunPods:${'ab'.repeat(32)}`)).toBeNull();
    expect(dbMock.dbWrite.apiKey.findFirst).not.toHaveBeenCalled();
  });

  it('control: a user API key still resolves', async () => {
    expect(await getSessionFromBearerToken('0123456789abcdef0123456789abcdef')).not.toBeNull();
  });
});
