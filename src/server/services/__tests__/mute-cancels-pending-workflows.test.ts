import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import type * as SessionInvalidation from '~/server/auth/session-invalidation';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';

// A mute cancels the account's pending generations BEFORE its session step and token revoke: once
// the orchestrator sees a restricted identity, the account's token can neither list nor cancel.
// Do not move the cancel after the revoke, and do not let its failure stop the rest of the mute.

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

const { afterAccountStandingChanged } = await import('~/server/services/account-standing.service');

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

  it('still takes the session step and revokes when the cancel fails', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: true } as never);
    cancelPendingWorkflows.mockImplementationOnce(async () => {
      throw new Error('orchestrator down');
    });
    await expect(afterAccountStandingChanged(USER, MUTE)).resolves.toBe(true);
    await vi.waitFor(() => expect(order).toContain('revoke'));
    expect(order).toEqual(['session', 'revoke']);
  });

  it('cancels nothing on an unmute', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: false } as never);
    await afterAccountStandingChanged(USER, MUTE);
    expect(cancelPendingWorkflows).not.toHaveBeenCalled();
  });
});
