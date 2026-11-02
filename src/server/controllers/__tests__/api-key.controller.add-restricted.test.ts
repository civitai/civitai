import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TosReacceptance from '~/server/services/tos-reacceptance.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { RESTRICTED_ACCOUNT_MESSAGE } from '~/server/common/content-restriction';

vi.mock('~/server/services/tos-reacceptance.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TosReacceptance>()),
  shouldOfferTosReacceptance: vi.fn(async () => false),
}));

const { addApiKeyHandler } = await import('~/server/controllers/api-key.controller');

const USER_ID = 31;
type Row = { muted: boolean; mutedAt: Date | null; bannedAt: Date | null; deletedAt: Date | null };
const OPEN: Row = { muted: false, mutedAt: null, bannedAt: null, deletedAt: null };

function givenAccount(row: Row | null) {
  dbMock.dbWrite.user.findUnique.mockResolvedValue(row as never);
}

function add() {
  return addApiKeyHandler({
    ctx: { user: { id: USER_ID, muted: false, mutedAt: null } } as never,
    input: { name: 'k', tokenScope: 1 } as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.user.findUnique.mockReset();
  dbMock.dbWrite.apiKey.create.mockReset();
  dbMock.dbWrite.apiKey.create.mockResolvedValue({} as never);
  installFakeCacheRedis();
});

describe('apiKey.add refuses a restricted account', () => {
  it('creates a key for an account in good standing', async () => {
    givenAccount(OPEN);
    await expect(add()).resolves.toEqual(expect.any(String));
    expect(dbMock.dbWrite.apiKey.create).toHaveBeenCalledTimes(1);
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
