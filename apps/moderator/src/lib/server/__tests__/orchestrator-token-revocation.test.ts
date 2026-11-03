import { beforeEach, describe, expect, it, vi } from 'vitest';

const logAxiomError = vi.hoisted(() => vi.fn(async () => undefined));

// The generated client does not load under the unit runner, and this function does not use it.
vi.mock('@civitai/orchestration-client', () => ({ createCivitaiClient: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({
  env: { ORCHESTRATOR_ENDPOINT: 'https://orch.test/', ORCHESTRATOR_ACCESS_TOKEN: 'svc-token' },
}));
vi.mock('../axiom', () => ({ logAxiomError }));

const { revokeOrchestratorUserTokens } = await import('../orchestrator');

type Call = { url: string; init: RequestInit };
let calls: Call[];

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  calls = [];
});

const answer = (status: number) =>
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status });
  });

describe('revokeOrchestratorUserTokens', () => {
  it("DELETEs the account's token cache with the service token", async () => {
    answer(204);
    expect(await revokeOrchestratorUserTokens(42)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://orch.test/v2/consumer/civitai/42/tokens');
    expect(calls[0].init.method).toBe('DELETE');
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer svc-token');
  });

  it('answers false, logged, when the orchestrator refuses', async () => {
    answer(500);
    expect(await revokeOrchestratorUserTokens(42)).toBe(false);
    expect(logAxiomError).toHaveBeenCalled();
  });

  it('answers false, without throwing, when the orchestrator cannot be reached', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(revokeOrchestratorUserTokens(42)).resolves.toBe(false);
    expect(logAxiomError).toHaveBeenCalled();
  });
});
