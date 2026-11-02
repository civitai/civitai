import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import type * as SessionInvalidation from '~/server/auth/session-invalidation';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { revokeTokens, refreshSession, invalidateSession } = vi.hoisted(() => ({
  revokeTokens: vi.fn(async (_: { userId: number | string }) => true),
  refreshSession: vi.fn(async (_userId: number, _opts?: unknown) => undefined),
  invalidateSession: vi.fn(async (_userId: number, _caller?: unknown) => undefined),
}));
vi.mock('~/server/auth/session-invalidation', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionInvalidation>()),
  refreshSession,
  invalidateSession,
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens: revokeTokens,
}));

import {
  ACCOUNT_STANDING_CACHE_DEADLINE_MS,
  ACCOUNT_STANDING_REBUST_MS,
  afterAccountStandingChanged,
  isAccountMuted,
} from '~/server/services/account-standing.service';

const USER = 42;
const MUTE = { kind: 'invalidate', caller: 'moderation' } as const;
const givenRow = (muted: boolean) =>
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted } as never);
const logged = (name: string) =>
  loggingMock.logToAxiom.mock.calls.some(([entry]) => (entry as { name?: string }).name === name);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.user.findUnique.mockReset();
  revokeTokens.mockResolvedValue(true);
  refreshSession.mockResolvedValue(undefined);
  invalidateSession.mockResolvedValue(undefined);
  installFakeCacheRedis();
});

describe('isAccountMuted', () => {
  it('answers from the stored row, not the session', async () => {
    givenRow(true);
    expect(await isAccountMuted(USER, false)).toBe(true);
  });

  it('serves a repeat read from the cache', async () => {
    givenRow(false);
    await isAccountMuted(USER, false);
    await isAccountMuted(USER, false);
    expect(dbMock.dbWrite.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('sees a mute at once after the change is announced', async () => {
    givenRow(false);
    expect(await isAccountMuted(USER, false)).toBe(false);
    givenRow(true);
    await afterAccountStandingChanged(USER, MUTE);
    expect(await isAccountMuted(USER, false)).toBe(true);
  });

  it('falls back to the session value, logged, when the database cannot answer', async () => {
    dbMock.dbWrite.user.findUnique.mockRejectedValue(new Error('db down'));
    expect(await isAccountMuted(USER, false)).toBe(false);
    expect(await isAccountMuted(USER, true)).toBe(true);
    expect(logged('account-standing.cache-read-failed')).toBe(true);
  });

  it('keeps each account to its own standing, through the cache', async () => {
    dbMock.dbWrite.user.findUnique.mockImplementation((async (args: { where: { id: number } }) => ({
      muted: args.where.id === 42,
    })) as never);
    expect(await isAccountMuted(42, false)).toBe(true);
    expect(await isAccountMuted(43, false)).toBe(false);
    expect(await isAccountMuted(42, false)).toBe(true);
    expect(await isAccountMuted(43, false)).toBe(false);
  });

  it('reads a missing row as not muted', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(null);
    expect(await isAccountMuted(USER, false)).toBe(false);
  });

  it('reads the row directly when another request holds the refill, and shares that read', async () => {
    // A cold key whose refill lock is taken: with no retry, `fetchThroughCache` gives up at once.
    redisMock.redis.set.mockImplementation((async (
      _key: string,
      _v: unknown,
      opts?: { NX?: boolean }
    ) => (opts?.NX ? null : 'OK')) as never);
    let finish: (row: { muted: boolean }) => void = () => undefined;
    dbMock.dbWrite.user.findUnique.mockReturnValue(
      new Promise((resolve) => (finish = resolve)) as never
    );
    const reads = [isAccountMuted(USER, false), isAccountMuted(USER, false)];
    await vi.waitFor(() => expect(dbMock.dbWrite.user.findUnique).toHaveBeenCalled());
    finish({ muted: true });
    expect(await Promise.all(reads)).toEqual([true, true]);
    expect(dbMock.dbWrite.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('stops waiting on a stalled cache after its deadline and reads the row', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      redisMock.redis.packed.get.mockReturnValue(new Promise(() => undefined) as never);
      givenRow(true);
      const read = isAccountMuted(USER, false);
      await vi.advanceTimersByTimeAsync(ACCOUNT_STANDING_CACHE_DEADLINE_MS - 1);
      expect(dbMock.dbWrite.user.findUnique).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await read).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('afterAccountStandingChanged', () => {
  it('revokes only after the session step, so the orchestrator cannot re-cache the old standing', async () => {
    await afterAccountStandingChanged(USER, MUTE);
    expect(invalidateSession).toHaveBeenCalledWith(USER, 'moderation');
    expect(revokeTokens).toHaveBeenCalledOnce();
    expect(revokeTokens.mock.invocationCallOrder[0]).toBeGreaterThan(
      invalidateSession.mock.invocationCallOrder[0]
    );
  });

  it('takes the session step the caller names', async () => {
    await afterAccountStandingChanged(USER, { kind: 'refresh', caller: 'strike' });
    expect(refreshSession).toHaveBeenCalledWith(USER, { caller: 'strike' });
    expect(invalidateSession).not.toHaveBeenCalled();
  });

  it('still revokes, and does not throw, when the session step fails', async () => {
    invalidateSession.mockRejectedValue(new Error('sysredis down'));
    await expect(afterAccountStandingChanged(USER, MUTE)).resolves.toBeUndefined();
    expect(revokeTokens).toHaveBeenCalledOnce();
  });

  it("revokes the account's cached orchestrator tokens", async () => {
    await afterAccountStandingChanged(USER, MUTE);
    expect(revokeTokens).toHaveBeenCalledExactlyOnceWith({ userId: USER });
  });

  it('does not wait on, or throw for, a failed revocation', async () => {
    revokeTokens.mockRejectedValue(new Error('orchestrator down'));
    await expect(afterAccountStandingChanged(USER, MUTE)).resolves.toBeUndefined();
    revokeTokens.mockImplementation(() => new Promise<boolean>(() => undefined));
    await expect(afterAccountStandingChanged(USER, MUTE)).resolves.toBeUndefined();
  });

  it('does not throw when the cache bust fails', async () => {
    redisMock.redis.del.mockRejectedValue(new Error('redis down'));
    await expect(afterAccountStandingChanged(USER, MUTE)).resolves.toBeUndefined();
    expect(revokeTokens).toHaveBeenCalledOnce();
  });

  it('busts again after any refill that read the row before the change could have landed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      givenRow(true);
      await afterAccountStandingChanged(USER, MUTE);
      // A refill that read the row before the mute committed lands after the first bust; its lock
      // lets it land for up to 10 s.
      givenRow(false);
      expect(await isAccountMuted(USER, false)).toBe(false);
      givenRow(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await isAccountMuted(USER, false)).toBe(false);
      expect(revokeTokens).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(ACCOUNT_STANDING_REBUST_MS - 10_000);
      expect(await isAccountMuted(USER, false)).toBe(true);
      expect(revokeTokens).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
