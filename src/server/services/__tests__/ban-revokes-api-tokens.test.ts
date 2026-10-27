import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as LegalHold from '~/server/services/legal-hold.service';
import type * as Revocation from '~/server/services/user-token-revocation.service';

// A banned or deleted account's API keys and OAuth tokens must stop working everywhere, including
// in the orchestrator's auth cache. `revokeUserTokens` does that and is covered on its own; this
// pins that every ban and deletion reaches it.

const { revokeUserTokens } = vi.hoisted(() => ({ revokeUserTokens: vi.fn() }));
vi.mock('~/server/services/user-token-revocation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Revocation>()),
  revokeUserTokens,
}));

vi.mock('~/server/services/legal-hold.service', async (importOriginal) => ({
  ...(await importOriginal<typeof LegalHold>()),
  assertAccountNotUnderLegalHold: vi.fn(async () => ({ legs: [], markerView: false })),
}));

// event-engine-common is a git submodule and is not checked out by default; user.service's graph
// reaches it.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

const { deleteUser, toggleBan } = await import('~/server/services/user.service');

const USER = 4242;
const account = (bannedAt: Date | null) => ({
  id: USER,
  bannedAt,
  meta: {},
  username: 'someone',
  email: 'someone@example.test',
});

beforeEach(() => {
  vi.clearAllMocks();
  revokeUserTokens.mockResolvedValue(true);
  for (const model of ['userLink', 'model', 'comment', 'commentV2', 'post', 'article'] as const) {
    dbMock.dbWrite[model].deleteMany?.mockResolvedValue({ count: 0 } as never);
    dbMock.dbWrite[model].updateMany?.mockResolvedValue({ count: 0 } as never);
  }
  dbMock.dbWrite.user.update.mockResolvedValue(account(new Date()) as never);
});

describe('banning revokes the account’s API tokens', () => {
  it('a ban revokes them', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(account(null) as never);
    dbMock.dbWrite.user.findUnique.mockResolvedValue(account(null) as never);
    await toggleBan({ id: USER, userId: 1, isModerator: true } as never);
    expect(revokeUserTokens).toHaveBeenCalledWith(USER);
  });

  it('the automated ban path (`onlyBan`) revokes them', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(account(null) as never);
    dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) =>
      fn({
        user: {
          updateMany: async () => ({ count: 1 }),
          findUniqueOrThrow: async () => account(new Date()),
        },
        modActivity: { create: async () => ({}) },
      })) as never);
    await toggleBan({ id: USER, userId: -1, onlyBan: true } as never);
    expect(revokeUserTokens).toHaveBeenCalledWith(USER);
  });

  it('an unban does not', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(account(new Date()) as never);
    dbMock.dbWrite.user.findUnique.mockResolvedValue(account(new Date()) as never);
    await toggleBan({ id: USER, userId: 1, isModerator: true } as never);
    expect(revokeUserTokens).not.toHaveBeenCalled();
  });
});

describe('deleting an account revokes its API tokens', () => {
  it('deleteUser revokes them', async () => {
    dbMock.dbWrite.user.findFirst.mockResolvedValue(account(null) as never);
    dbMock.dbWrite.$transaction.mockResolvedValue([] as never);
    await deleteUser({ id: USER, username: 'someone', removeModels: false } as never);
    expect(revokeUserTokens).toHaveBeenCalledWith(USER);
  });
});
