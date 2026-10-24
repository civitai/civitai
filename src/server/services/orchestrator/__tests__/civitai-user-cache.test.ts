import { beforeEach, describe, expect, it, vi } from 'vitest';
import { envMock } from '~/__tests__/mocks/env.mock';

const { deleteMock } = vi.hoisted(() => ({ deleteMock: vi.fn(async () => undefined) }));
vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: vi.fn(() => ({ delete: deleteMock })),
}));

const { invalidateCivitaiUser, revokeCivitaiUserTokens } = await import(
  '~/server/services/orchestrator/civitai'
);

beforeEach(() => {
  deleteMock.mockClear();
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

  it('a failed call does not throw', async () => {
    deleteMock.mockRejectedValueOnce(new Error('orchestrator down'));
    await expect(revokeCivitaiUserTokens({ userId: 501 })).resolves.toBeUndefined();
  });
});
