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

const BANNED_AT = Date.parse('2026-10-27T12:00:00.000Z') / 1000;
/** The `tokenRevocation` field each raw UPDATE stamped, and the ban it was scoped to. */
const stamps = () =>
  dbMock.dbWrite.$executeRaw.mock.calls.map((call) => {
    const values = (call as unknown[]).slice(1);
    return [values.find((v) => v === 'confirmedAt' || v === 'alertedAt'), values.at(-1)];
  });

beforeEach(() => {
  vi.clearAllMocks();
  expireUserApiKeys.mockResolvedValue({ expired: 2, orchestratorConfirmed: true });
  revokeCivitaiUserTokens.mockResolvedValue(true);
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ since: BANNED_AT }] as never);
});

describe('revokeUserTokens', () => {
  it('stamps confirmation when the first orchestrator call is confirmed, without retrying', async () => {
    await expect(revokeUserTokens(501, { retryDelaysMs: [0, 0] })).resolves.toBe(true);
    expect(expireUserApiKeys).toHaveBeenCalledWith(501);
    expect(revokeCivitaiUserTokens).not.toHaveBeenCalled();
    expect(stamps()).toEqual([['confirmedAt', BANNED_AT]]);
  });

  it('retries an unconfirmed orchestrator call and stamps once it is confirmed', async () => {
    expireUserApiKeys.mockResolvedValue({ expired: 2, orchestratorConfirmed: false });
    revokeCivitaiUserTokens.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(revokeUserTokens(501, { retryDelaysMs: [0, 0] })).resolves.toBe(true);
    expect(revokeCivitaiUserTokens).toHaveBeenCalledTimes(2);
    expect(stamps()).toEqual([['confirmedAt', BANNED_AT]]);
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

  it('does nothing to an account that is no longer banned or deleted', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ since: null }] as never);
    await expect(revokeUserTokens(501, { retryDelaysMs: [] })).resolves.toBe(false);
    expect(expireUserApiKeys).not.toHaveBeenCalled();
    expect(stamps()).toEqual([]);
  });

  it('revokes but leaves the stamp to the job when the ban cannot be read', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValue(new Error('primary unavailable'));
    await expect(revokeUserTokens(501, { retryDelaysMs: [] })).resolves.toBe(false);
    expect(expireUserApiKeys).toHaveBeenCalledWith(501);
    expect(stamps()).toEqual([]);
  });

  it('never throws when the stamp cannot be written', async () => {
    dbMock.dbWrite.$executeRaw.mockRejectedValueOnce(new Error('primary unavailable'));
    await expect(revokeUserTokens(501, { retryDelaysMs: [] })).resolves.toBe(true);
  });
});
