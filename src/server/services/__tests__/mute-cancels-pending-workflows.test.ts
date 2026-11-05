import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import type * as SessionInvalidation from '~/server/auth/session-invalidation';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';

// A mute drops the cached standing FIRST, so a submit during the cancel is refused; then cancels
// the pending generations; then takes its session step and revokes the tokens. The delayed repeat
// cancels once more after its own revoke. Do not move the first cancel before the bust or after
// the revoke, and do not let a failed cancel stop the rest of the mute.

const order = vi.hoisted(() => [] as string[]);
const cancelPendingWorkflows = vi.hoisted(() =>
  vi.fn(async (_userId: number) => {
    order.push('cancel');
  })
);
vi.mock('~/server/services/orchestrator/cancel-pending-workflows', () => ({
  cancelPendingWorkflows,
}));
vi.mock('~/server/auth/session-cache', () => ({ clearSessionCache: vi.fn(async () => undefined) }));
vi.mock('~/server/auth/session-invalidation', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionInvalidation>()),
  refreshSession: vi.fn(async () => void order.push('session')),
  invalidateSession: vi.fn(async () => void order.push('session')),
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens: vi.fn(async () => {
    order.push('revoke');
    return true;
  }),
}));

const { ACCOUNT_STANDING_REBUST_MS, afterAccountStandingChanged, getAccountStanding } =
  await import('~/server/services/account-standing.service');
const { assertAccountNotRestricted } = await import(
  '~/server/services/account-restriction.service'
);

const USER = 42;
const MUTE = { kind: 'refresh', caller: 'moderation' } as const;

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  installFakeCacheRedis();
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  dbMock.dbWrite.apiKey.findMany.mockResolvedValue([] as never);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('a mute and the account’s pending generations', () => {
  it('cancels them before the session step and the token revoke', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: true } as never);
    await afterAccountStandingChanged(USER, MUTE);
    // The revoke is fired without awaiting; let it run.
    await vi.waitFor(() => expect(order).toContain('revoke'));
    expect(cancelPendingWorkflows).toHaveBeenCalledTimes(1);
    expect(cancelPendingWorkflows).toHaveBeenCalledWith(USER);
    expect(order).toEqual(['cancel', 'session', 'revoke']);
  });

  it('refuses a submit made while the cancel runs, the standing still cached as unmuted', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: false } as never);
    expect((await getAccountStanding(USER)).muted).toBe(false);
    // The mute commits; the cache still holds the unmuted standing read before it.
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: true } as never);
    let submitDuringCancel: 'allowed' | 'refused' | undefined;
    cancelPendingWorkflows.mockImplementationOnce(async () => {
      submitDuringCancel = await assertAccountNotRestricted(USER).then(
        () => 'allowed' as const,
        () => 'refused' as const
      );
      order.push('cancel');
    });
    await afterAccountStandingChanged(USER, MUTE);
    expect(submitDuringCancel).toBe('refused');
  });

  it('still takes the session step and revokes when the cancel fails', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: true } as never);
    cancelPendingWorkflows.mockImplementationOnce(async () => {
      throw new Error('orchestrator down');
    });
    await expect(afterAccountStandingChanged(USER, MUTE)).resolves.toBe(true);
    await vi.waitFor(() => expect(order).toContain('revoke'));
    expect(order).toEqual(['session', 'revoke']);
  });

  it('cancels again in the delayed repeat, after its revoke has landed', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: true } as never);
    await afterAccountStandingChanged(USER, MUTE);
    await vi.waitFor(() => expect(order).toContain('revoke'));
    order.length = 0;
    await vi.advanceTimersByTimeAsync(ACCOUNT_STANDING_REBUST_MS);
    await vi.waitFor(() => expect(order).toContain('cancel'));
    expect(order).toEqual(['revoke', 'cancel']);
    expect(cancelPendingWorkflows).toHaveBeenCalledTimes(2);
  });

  it('cancels nothing on an unmute', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: false } as never);
    await afterAccountStandingChanged(USER, MUTE);
    expect(cancelPendingWorkflows).not.toHaveBeenCalled();
  });
});
