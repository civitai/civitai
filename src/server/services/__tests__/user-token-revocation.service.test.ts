import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ApiKeyService from '~/server/services/api-key.service';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';

const { expireUserApiKeys, revokeCivitaiUserTokens } = vi.hoisted(() => ({
  expireUserApiKeys: vi.fn(),
  revokeCivitaiUserTokens: vi.fn(),
}));
vi.mock('~/server/services/api-key.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyService>()),
  expireUserApiKeys,
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens,
}));

const { revokeUserTokens } = await import('~/server/services/user-token-revocation.service');

/** The `tokenRevocation` fields stamped on the account, read off the raw UPDATE's bound values. */
const stamps = () =>
  dbMock.dbWrite.$executeRaw.mock.calls.map((call) =>
    (call as unknown[]).slice(1).find((v) => typeof v === 'string')
  );

beforeEach(() => {
  vi.clearAllMocks();
  expireUserApiKeys.mockResolvedValue({ expired: 2, orchestratorConfirmed: true });
  revokeCivitaiUserTokens.mockResolvedValue(true);
});

describe('revokeUserTokens', () => {
  it('stamps confirmation when the first orchestrator call is confirmed, without retrying', async () => {
    await expect(revokeUserTokens(501, { retryDelaysMs: [0, 0] })).resolves.toBe(true);
    expect(expireUserApiKeys).toHaveBeenCalledWith(501);
    expect(revokeCivitaiUserTokens).not.toHaveBeenCalled();
    expect(stamps()).toEqual(['confirmedAt']);
  });

  it('retries an unconfirmed orchestrator call and stamps once it is confirmed', async () => {
    expireUserApiKeys.mockResolvedValue({ expired: 2, orchestratorConfirmed: false });
    revokeCivitaiUserTokens.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(revokeUserTokens(501, { retryDelaysMs: [0, 0] })).resolves.toBe(true);
    expect(revokeCivitaiUserTokens).toHaveBeenCalledTimes(2);
    expect(stamps()).toEqual(['confirmedAt']);
  });

  it('gives up after the retries without stamping, so the job keeps trying', async () => {
    expireUserApiKeys.mockResolvedValue({ expired: 2, orchestratorConfirmed: false });
    revokeCivitaiUserTokens.mockResolvedValue(false);
    await expect(revokeUserTokens(501, { retryDelaysMs: [0, 0] })).resolves.toBe(false);
    expect(revokeCivitaiUserTokens).toHaveBeenCalledTimes(2);
    expect(stamps()).toEqual([]);
  });

  it('never throws when expiring the keys fails, and leaves the account unconfirmed', async () => {
    expireUserApiKeys.mockRejectedValue(new Error('primary unavailable'));
    await expect(revokeUserTokens(501, { retryDelaysMs: [0] })).resolves.toBe(false);
    expect(stamps()).toEqual([]);
  });

  it('never throws when the stamp cannot be written', async () => {
    dbMock.dbWrite.$executeRaw.mockRejectedValueOnce(new Error('primary unavailable'));
    await expect(revokeUserTokens(501, { retryDelaysMs: [] })).resolves.toBe(true);
  });
});
