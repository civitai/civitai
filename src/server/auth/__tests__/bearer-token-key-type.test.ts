import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as KeyGenerator from '~/server/utils/key-generator';

vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => key,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: vi.fn(async (id: number) => ({ id, bannedAt: null })) },
}));

const { getSessionFromBearerToken } = await import('~/server/auth/bearer-token');

const row = (type: string) => ({
  id: 77,
  userId: 5,
  tokenScope: 1,
  lastUsedAt: new Date(),
  buzzLimit: null,
  clientId: null,
  type,
});

beforeEach(() => {
  dbMock.dbWrite.apiKey.findFirst.mockReset();
});

describe('getSessionFromBearerToken key type', () => {
  it.each(['User', 'System'])('reports the stored %s type', async (type) => {
    dbMock.dbWrite.apiKey.findFirst.mockResolvedValue(row(type));
    const result = await getSessionFromBearerToken('k');
    expect(result?.apiKeyType).toBe(type);
    expect(dbMock.dbWrite.apiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ type: true }) })
    );
  });
});
