import { beforeEach, describe, expect, it, vi } from 'vitest';
import { envMock } from '~/__tests__/mocks/env.mock';

const { deleteMock } = vi.hoisted(() => ({
  deleteMock:
    vi.fn<(args: { url: string }) => Promise<{ response: { ok: boolean; status: number } }>>(),
}));
vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: vi.fn(() => ({ delete: deleteMock })),
}));

const { invalidateCivitaiUser, revokeCivitaiUserTokens } = await import(
  '~/server/services/orchestrator/civitai'
);

beforeEach(() => {
  deleteMock.mockReset();
  deleteMock.mockResolvedValue({ response: { ok: true, status: 204 } });
  envMock.set({ ORCHESTRATOR_ACCESS_TOKEN: 'system-token' });
});

describe('orchestrator user cache invalidation', () => {
  // The user-info route does not touch the orchestrator's cached auth; only the tokens route does.
  it('revokeCivitaiUserTokens calls the tokens route', async () => {
    await revokeCivitaiUserTokens({ userId: 501 });
    expect(deleteMock).toHaveBeenCalledWith({ url: '/v2/consumer/civitai/501/tokens' });
  });

  it('invalidateCivitaiUser calls the user-info route', async () => {
    await invalidateCivitaiUser({ userId: 501 });
    expect(deleteMock).toHaveBeenCalledWith({ url: '/v2/consumer/civitai/501' });
  });

  it('reports a 2xx as confirmed', async () => {
    await expect(revokeCivitaiUserTokens({ userId: 501 })).resolves.toBe(true);
  });

  // The client resolves, rather than throws, on an error status.
  it('reports an error status as unconfirmed', async () => {
    deleteMock.mockResolvedValueOnce({ response: { ok: false, status: 503 } });
    await expect(revokeCivitaiUserTokens({ userId: 501 })).resolves.toBe(false);
  });

  it('a failed call does not throw, and is unconfirmed', async () => {
    deleteMock.mockRejectedValueOnce(new Error('orchestrator down'));
    await expect(revokeCivitaiUserTokens({ userId: 501 })).resolves.toBe(false);
  });

  it('is unconfirmed when there is no system token to call with', async () => {
    envMock.set({ ORCHESTRATOR_ACCESS_TOKEN: undefined });
    await expect(revokeCivitaiUserTokens({ userId: 501 })).resolves.toBe(false);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
