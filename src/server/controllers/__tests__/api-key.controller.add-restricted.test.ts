import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TosReacceptance from '~/server/services/tos-reacceptance.service';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { RESTRICTED_ACCOUNT_MESSAGE } from '~/server/common/content-restriction';

vi.mock('~/server/services/tos-reacceptance.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TosReacceptance>()),
  shouldOfferTosReacceptance: vi.fn(async () => false),
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens: vi.fn(async () => true),
}));

const { addApiKeyHandler } = await import('~/server/controllers/api-key.controller');

const USER_ID = 31;
type Row = { muted: boolean; mutedAt: Date | null; bannedAt: Date | null; deletedAt: Date | null };
const OPEN: Row = { muted: false, mutedAt: null, bannedAt: null, deletedAt: null };

function givenAccount(row: Row | null) {
  dbMock.dbWrite.user.findUnique.mockResolvedValue(row as never);
}

type KeyRow = { id: number; userId: number; key: string; expiresAt: Date | null };
let keys: KeyRow[] = [];

function add() {
  return addApiKeyHandler({
    ctx: { user: { id: USER_ID, muted: false, mutedAt: null } } as never,
    input: { name: 'k', tokenScope: 1 } as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.user.findUnique.mockReset();
  keys = [];
  dbMock.dbWrite.apiKey.create.mockReset();
  dbMock.dbWrite.apiKey.create.mockImplementation((async ({ data }: { data: KeyRow }) => {
    keys.push({ id: keys.length + 1, userId: data.userId, key: data.key, expiresAt: null });
    return {};
  }) as never);
  dbMock.dbWrite.apiKey.findMany.mockReset();
  dbMock.dbWrite.apiKey.findMany.mockImplementation((async ({
    where,
  }: {
    where: { userId: number };
  }) => keys.filter((k) => k.userId === where.userId)) as never);
  dbMock.dbWrite.apiKey.updateMany.mockReset();
  dbMock.dbWrite.apiKey.updateMany.mockImplementation((async ({
    where,
    data,
  }: {
    where: { id: { in: number[] } };
    data: { expiresAt: Date };
  }) => {
    for (const k of keys) if (where.id.in.includes(k.id)) k.expiresAt = data.expiresAt;
    return { count: where.id.in.length };
  }) as never);
  installFakeCacheRedis();
  vi.stubEnv('NEXTAUTH_SECRET', 'test-secret');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('apiKey.add refuses a restricted account', () => {
  it('creates a key for an account in good standing', async () => {
    givenAccount(OPEN);
    await expect(add()).resolves.toEqual(expect.any(String));
    expect(keys).toEqual([expect.objectContaining({ userId: USER_ID, expiresAt: null })]);
  });

  it.each<[string, Row | null]>([
    ['a muted account', { ...OPEN, muted: true, mutedAt: new Date('2026-10-01') }],
    // An automatic mute leaves mutedAt unset and must still refuse: do not key the check on mutedAt.
    ['an automatically muted account (mutedAt unset)', { ...OPEN, muted: true }],
    ['a banned account', { ...OPEN, bannedAt: new Date('2026-10-01') }],
    ['a deleted account', { ...OPEN, deletedAt: new Date('2026-10-01') }],
    ['an account with no row', null],
  ])('refuses %s', async (_label, row) => {
    givenAccount(row);
    await expect(add()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: RESTRICTED_ACCOUNT_MESSAGE,
    });
    expect(dbMock.dbWrite.apiKey.create).not.toHaveBeenCalled();
  });

  it('refuses when the standing cannot be read', async () => {
    dbMock.dbWrite.user.findUnique.mockRejectedValue(new Error('connection terminated'));
    await expect(add()).rejects.toThrow('connection terminated');
    expect(dbMock.dbWrite.apiKey.create).not.toHaveBeenCalled();
  });
});

describe('apiKey.add when a ban or deletion lands during the insert', () => {
  it.each<[string, Row]>([
    ['a ban', { ...OPEN, bannedAt: new Date('2026-10-01') }],
    ['a deletion', { ...OPEN, deletedAt: new Date('2026-10-01') }],
  ])('expires the new key after %s', async (_label, closed) => {
    // Reads in order: the standing, the check before the insert, the check after it.
    dbMock.dbWrite.user.findUnique
      .mockResolvedValueOnce(OPEN as never)
      .mockResolvedValueOnce(OPEN as never)
      .mockResolvedValue(closed as never);
    await expect(add()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: RESTRICTED_ACCOUNT_MESSAGE,
    });
    expect(keys).toHaveLength(1);
    expect(keys[0].expiresAt).toBeInstanceOf(Date);
  });
});
