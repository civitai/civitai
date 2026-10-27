import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import type * as Revocation from '~/server/services/user-token-revocation.service';

const { revokeCivitaiUserTokens, revokeUserTokens, markTokenRevocation } = vi.hoisted(() => ({
  revokeCivitaiUserTokens: vi.fn(),
  revokeUserTokens: vi.fn(),
  markTokenRevocation: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens,
}));
vi.mock('~/server/services/user-token-revocation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Revocation>()),
  revokeUserTokens,
  markTokenRevocation,
}));

const { revokeRecentlyBannedUserTokens } = await import('~/server/jobs/revoke-user-tokens');

const NOW = new Date('2026-10-27T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);
const account = (id: number, ageHours: number, revocation: Record<string, string> | null) => ({
  id,
  since: hoursAgo(ageHours),
  revocation,
});

beforeEach(() => {
  vi.clearAllMocks();
  revokeCivitaiUserTokens.mockResolvedValue(true);
  revokeUserTokens.mockResolvedValue(false);
  markTokenRevocation.mockResolvedValue(undefined);
});

describe('revoke-user-tokens job', () => {
  it('re-sends the orchestrator expiry for a confirmed account for its first day only', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      account(1, 2, { confirmedAt: hoursAgo(2).toISOString() }),
      account(2, 30, { confirmedAt: hoursAgo(30).toISOString() }),
    ] as never);
    await revokeRecentlyBannedUserTokens(NOW);
    expect(revokeCivitaiUserTokens.mock.calls).toEqual([[{ userId: 1 }]]);
    expect(revokeUserTokens).not.toHaveBeenCalled();
  });

  it('retries the whole revocation for an unconfirmed account, whatever its age', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([account(3, 1, null), account(4, 40, {})] as never);
    revokeUserTokens.mockResolvedValueOnce(true);
    await expect(revokeRecentlyBannedUserTokens(NOW)).resolves.toEqual({
      accounts: 2,
      unconfirmed: 1,
    });
    expect(revokeUserTokens.mock.calls.map(([id]) => id).sort()).toEqual([3, 4]);
    expect(markTokenRevocation).not.toHaveBeenCalled();
  });

  it('alerts once on an account still unconfirmed at 48h', async () => {
    const { logToAxiom } = await import('~/server/logging/client');
    const spy = vi.mocked(logToAxiom);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      account(5, 49, null),
      account(6, 50, { alertedAt: hoursAgo(1).toISOString() }),
      account(7, 47, null),
    ] as never);
    await revokeRecentlyBannedUserTokens(NOW);
    expect(markTokenRevocation.mock.calls).toEqual([[5, 'alertedAt']]);
    const alerts = spy.mock.calls.filter(
      ([entry]) => (entry as { name?: string }).name === 'user-token-revocation-unconfirmed'
    );
    expect(alerts.map(([entry]) => (entry as { userId: number }).userId)).toEqual([5]);
  });
});
