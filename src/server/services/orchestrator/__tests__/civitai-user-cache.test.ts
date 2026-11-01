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

let status = 204;

beforeEach(() => {
  deleteMock.mockReset();
  // The generated client's contract: with `throwOnError` an error status rejects with the parsed body.
  deleteMock.mockImplementation(async ({ throwOnError }) => {
    if (status >= 300) {
      if (throwOnError) throw { status, detail: 'Service Unavailable' };
      return { error: { status }, response: { ok: false, status } };
    }
    return { data: undefined, response: { ok: true, status } };
  });
  status = 204;
  envMock.set({ ORCHESTRATOR_ACCESS_TOKEN: 'system-token' });
});

describe('orchestrator user cache invalidation', () => {
  // The user-info route does not touch the orchestrator's cached auth; only the tokens route does.
  it('revokeCivitaiUserTokens calls the tokens route', async () => {
    await revokeCivitaiUserTokens({ userId: 501 });
    expect(deleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/v2/consumer/civitai/501/tokens' })
    );
  });

  it('invalidateCivitaiUser calls the user-info route', async () => {
    await invalidateCivitaiUser({ userId: 501 });
    expect(deleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/v2/consumer/civitai/501' })
    );
  });

  it('reports a 2xx as confirmed', async () => {
    await expect(revokeCivitaiUserTokens({ userId: 501 })).resolves.toBe(true);
  });

  // The client resolves, rather than throws, on an error status.
  it('reports an error status as unconfirmed', async () => {
    status = 503;
    await expect(revokeCivitaiUserTokens({ userId: 501 })).resolves.toBe(false);
  });

  it('logs the status of an error answer', async () => {
    const { logToAxiom } = await import('~/server/logging/client');
    status = 503;
    await revokeCivitaiUserTokens({ userId: 501 });
    const logged = vi.mocked(logToAxiom).mock.calls.at(-1)?.[0] as { error: { message: string } };
    expect(logged.error.message).toContain('503');
  });

  it('logs the real network error, and bounds each call with a timeout', async () => {
    const { logToAxiom } = await import('~/server/logging/client');
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    deleteMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await revokeCivitaiUserTokens({ userId: 501 });
    const [{ signal }] = deleteMock.mock.calls[0];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(timeout.mock.calls[0][0]).toBeLessThanOrEqual(10_000);
    timeout.mockRestore();
    const logged = vi.mocked(logToAxiom).mock.calls.at(-1)?.[0] as { error: { message: string } };
    expect(logged.error.message).toBe('fetch failed');
  });

  it('a failed call does not throw, and is unconfirmed, whatever it rejects with', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const rejection of [new Error('orchestrator down'), circular, { size: 1n }, undefined]) {
      deleteMock.mockRejectedValueOnce(rejection);
      await expect(revokeCivitaiUserTokens({ userId: 501 })).resolves.toBe(false);
    }
  });

  it('is unconfirmed when there is no system token to call with', async () => {
    envMock.set({ ORCHESTRATOR_ACCESS_TOKEN: undefined });
    await expect(revokeCivitaiUserTokens({ userId: 501 })).resolves.toBe(false);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
