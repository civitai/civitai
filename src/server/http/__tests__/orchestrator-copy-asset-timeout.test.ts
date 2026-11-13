import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

// copyAsset is sent with `wait: true`: the orchestrator answers only once a large training asset
// has been copied, which can take minutes. HttpCaller's default deadline (120 s) would cut a
// healthy copy short, so copyAsset must carry a budget of at least 300 s, while other calls on
// the same caller keep the default.
vi.mock('~/env/server', () => ({
  env: { ORCHESTRATOR_ENDPOINT: 'https://orchestrator.test', ORCHESTRATOR_ACCESS_TOKEN: 't' },
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: () => null,
}));
vi.mock('~/server/utils/errorHandling', () => ({ handleLogError: () => undefined }));

import orchestratorCaller from '~/server/http/orchestrator/orchestrator.caller';

let timeoutSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OrchestratorCaller deadlines', () => {
  it('copyAsset gets a deadline of at least 300 s', async () => {
    await orchestratorCaller.copyAsset({
      payload: { jobId: 'j', assetName: 'a', destinationUri: 'https://dest.test/x' },
      queryParams: { wait: true },
    });
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy.mock.calls[0][0]).toBeGreaterThanOrEqual(300_000);
  });

  it('other calls on the same caller keep the 120 s default (control)', async () => {
    await orchestratorCaller.clearAssets({ payload: { jobId: 'j' } as never });
    expect(timeoutSpy.mock.calls[0][0]).toBe(120_000);
  });
});
