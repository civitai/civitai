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

type Row = {
  id: number;
  key: string;
  userId: number;
  tokenScope: number;
  lastUsedAt: Date | null;
  buzzLimit: null;
  clientId: string | null;
  type: string;
  expiresAt: Date | null;
};

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + HOUR);
const SCOPE = 0b1011;

// An OAuth access/refresh pair minted together (same client, same scope), a personal key, a system
// key, an expired access token and a row of a type the code does not list. Ids, keys and owners are
// pairwise distinct, so a result names its row.
const ROWS: Row[] = [
  {
    id: 11,
    key: 'oauth-access',
    userId: 101,
    tokenScope: SCOPE,
    lastUsedAt: null,
    buzzLimit: null,
    clientId: 'client-a',
    type: 'Access',
    expiresAt: future(),
  },
  {
    id: 12,
    key: 'oauth-refresh',
    userId: 102,
    tokenScope: SCOPE,
    lastUsedAt: null,
    buzzLimit: null,
    clientId: 'client-a',
    type: 'Refresh',
    expiresAt: new Date(Date.now() + 2 * HOUR),
  },
  {
    id: 13,
    key: 'personal-key',
    userId: 103,
    tokenScope: SCOPE,
    lastUsedAt: null,
    buzzLimit: null,
    clientId: null,
    type: 'User',
    expiresAt: null,
  },
  {
    id: 14,
    key: 'expired-access',
    userId: 104,
    tokenScope: SCOPE,
    lastUsedAt: null,
    buzzLimit: null,
    clientId: 'client-a',
    type: 'Access',
    expiresAt: new Date(Date.now() - HOUR),
  },
  {
    id: 15,
    key: 'system-key',
    userId: 105,
    tokenScope: SCOPE,
    lastUsedAt: null,
    buzzLimit: null,
    clientId: null,
    type: 'System',
    expiresAt: future(),
  },
  {
    id: 16,
    key: 'unlisted-type',
    userId: 106,
    tokenScope: SCOPE,
    lastUsedAt: null,
    buzzLimit: null,
    clientId: null,
    type: 'Unlisted',
    expiresAt: future(),
  },
];

/**
 * Evaluates the Prisma `where` under test against ROWS. An operator or field it does not know
 * throws, so a respelled filter fails loudly instead of silently matching everything.
 */
function matchesValue(value: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    return value === cond;
  }
  return Object.entries(cond as Record<string, unknown>).every(([op, arg]) => {
    switch (op) {
      case 'equals':
        return matchesValue(value, arg);
      case 'not':
        return value !== null && !matchesValue(value, arg);
      case 'in':
        return (arg as unknown[]).includes(value);
      case 'notIn':
        return value !== null && !(arg as unknown[]).includes(value);
      case 'gte':
        return value instanceof Date && value.getTime() >= (arg as Date).getTime();
      case 'gt':
        return value instanceof Date && value.getTime() > (arg as Date).getTime();
      default:
        throw new Error(`fake where: unsupported operator ${op}`);
    }
  });
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, cond]) => {
    if (field === 'OR') return (cond as Record<string, unknown>[]).some((c) => matches(row, c));
    if (field === 'AND') {
      const all = Array.isArray(cond) ? cond : [cond];
      return (all as Record<string, unknown>[]).every((c) => matches(row, c));
    }
    if (field === 'NOT') {
      const all = Array.isArray(cond) ? cond : [cond];
      return (all as Record<string, unknown>[]).every((c) => !matches(row, c));
    }
    if (!(field in row)) throw new Error(`fake where: unknown field ${field}`);
    return matchesValue(row[field as keyof Row], cond);
  });
}

beforeEach(() => {
  dbMock.dbWrite.apiKey.findFirst.mockReset();
  dbMock.dbWrite.apiKey.findFirst.mockImplementation(
    (async ({ where }: { where: Record<string, unknown> }) =>
      ROWS.find((row) => matches(row, where)) ?? null) as never
  );
  dbMock.dbWrite.apiKey.update.mockReset();
  dbMock.dbWrite.apiKey.update.mockResolvedValue({} as never);
  dbMock.dbRead.oauthConsent.findUnique.mockResolvedValue(null);
});

describe('getSessionFromBearerToken credential type', () => {
  it('does not accept an OAuth refresh token as a bearer credential', async () => {
    expect(await getSessionFromBearerToken('oauth-refresh')).toBeNull();
    expect(dbMock.dbWrite.apiKey.update).not.toHaveBeenCalled();
  });

  it('accepts the access token minted alongside it (positive control)', async () => {
    const session = await getSessionFromBearerToken('oauth-access');
    expect(session?.user?.id).toBe(101);
    expect(session?.apiKeyId).toBe(11);
    expect(session?.apiKeyType).toBe('Access');
    expect(session?.tokenScope).toBe(SCOPE);
    expect(session?.subject).toEqual({ type: 'oauth', id: 'client-a' });
  });

  it('accepts a personal API key', async () => {
    const session = await getSessionFromBearerToken('personal-key');
    expect(session?.user?.id).toBe(103);
    expect(session?.apiKeyType).toBe('User');
    expect(session?.subject).toEqual({ type: 'apiKey', id: 13 });
  });

  it('accepts a system key', async () => {
    const session = await getSessionFromBearerToken('system-key');
    expect(session?.user?.id).toBe(105);
    expect(session?.apiKeyType).toBe('System');
  });

  it('does not accept a key type that is not allowlisted', async () => {
    expect(await getSessionFromBearerToken('unlisted-type')).toBeNull();
  });

  it('does not accept an expired access token', async () => {
    expect(await getSessionFromBearerToken('expired-access')).toBeNull();
  });

  it('fake rejects an operator it cannot evaluate (instrument control)', () => {
    expect(() => matches(ROWS[0], { type: { startsWith: 'R' } })).toThrow(/unsupported/);
  });
});
