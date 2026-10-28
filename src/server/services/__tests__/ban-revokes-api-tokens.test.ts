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
const STALE = { tokenRevocation: { confirmedAt: '2026-01-01T00:00:00.000Z' } };
const account = (bannedAt: Date | null) => ({
  id: USER,
  bannedAt,
  meta: STALE,
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
  // A confirmation left over from an earlier ban would make the job skip this one.
  const writtenMeta = () =>
    (
      dbMock.dbWrite.user.update.mock.calls.at(-1)?.[0] as {
        data: { meta: Record<string, unknown> };
      }
    ).data.meta;

  it('a ban revokes them, and clears an earlier ban’s confirmation', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(account(null) as never);
    dbMock.dbWrite.user.findUnique.mockResolvedValue(account(null) as never);
    await toggleBan({ id: USER, userId: 1, isModerator: true } as never);
    expect(revokeUserTokens).toHaveBeenCalledTimes(1);
    expect(revokeUserTokens).toHaveBeenCalledWith(USER);
    expect(writtenMeta().tokenRevocation).toBeUndefined();
  });

  it('revokes them before the slow cleanup starts', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(account(null) as never);
    let finish: () => void = () => undefined;
    revokeUserTokens.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const ban = toggleBan({ id: USER, userId: 1, isModerator: true } as never);
    await vi.waitFor(() => expect(revokeUserTokens).toHaveBeenCalled());
    expect(dbMock.dbWrite.userLink.deleteMany).not.toHaveBeenCalled();
    finish();
    await ban;
    expect(dbMock.dbWrite.userLink.deleteMany).toHaveBeenCalled();
  });

  it('a forced ban (the CSAM path) revokes them', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(account(new Date()) as never);
    await toggleBan({ id: USER, userId: 1, force: true } as never);
    expect(revokeUserTokens).toHaveBeenCalledTimes(1);
    expect(revokeUserTokens).toHaveBeenCalledWith(USER);
    expect(writtenMeta().tokenRevocation).toBeUndefined();
  });

  it('the automated ban path (`onlyBan`) revokes them, and clears an earlier confirmation', async () => {
    const updateMany = vi.fn<
      (args: { data: { meta: Record<string, unknown> } }) => Promise<{ count: number }>
    >(async () => ({ count: 1 }));
    dbMock.dbWrite.user.findUnique.mockResolvedValue(account(null) as never);
    dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) =>
      fn({
        user: {
          updateMany,
          findUniqueOrThrow: async () => account(new Date()),
        },
        modActivity: { create: async () => ({}) },
      })) as never);
    await toggleBan({ id: USER, userId: -1, onlyBan: true } as never);
    expect(revokeUserTokens).toHaveBeenCalledTimes(1);
    expect(revokeUserTokens).toHaveBeenCalledWith(USER);
    expect(updateMany.mock.calls[0][0].data.meta.tokenRevocation).toBeUndefined();
  });

  // The old confirmation stays: inert until a new ban clears it, since the job only reads banned or
  // deleted accounts.
  it('an unban does not revoke them', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(account(new Date()) as never);
    dbMock.dbWrite.user.findUnique.mockResolvedValue(account(new Date()) as never);
    await toggleBan({ id: USER, userId: 1, isModerator: true } as never);
    expect(revokeUserTokens).not.toHaveBeenCalled();
    expect(writtenMeta().tokenRevocation).toEqual(STALE.tokenRevocation);
  });
});

describe('deleting an account revokes its API tokens', () => {
  it('deleteUser revokes them', async () => {
    dbMock.dbWrite.user.findFirst.mockResolvedValue(account(null) as never);
    dbMock.dbWrite.$transaction.mockResolvedValue([] as never);
    await deleteUser({ id: USER, username: 'someone', removeModels: false } as never);
    expect(revokeUserTokens).toHaveBeenCalledTimes(1);
    expect(revokeUserTokens).toHaveBeenCalledWith(USER);
    const meta = (
      dbMock.dbWrite.user.update.mock.calls.at(-1)?.[0] as {
        data: { meta: Record<string, unknown> };
      }
    ).data.meta;
    expect(meta.tokenRevocation).toBeUndefined();
  });
});
