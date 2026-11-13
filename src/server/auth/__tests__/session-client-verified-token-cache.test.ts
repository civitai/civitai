import { describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';

// The app's exported sessionClient must be built with `verifiedTokenCache`: without it the package
// verifies the civ-token signature on every request. createSessionClient is spied to capture its config.
const h = vi.hoisted(() => ({ createSessionClient: vi.fn(() => ({})) }));
vi.mock('@civitai/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof CivitaiAuth>();
  return { ...actual, createSessionClient: h.createSessionClient };
});
vi.mock('../session-verifier', () => ({ isRevoked: vi.fn() }));

describe('sessionClient construction', () => {
  it('passes verifiedTokenCache alongside isRevoked', async () => {
    await import('../session-client');
    const { isRevoked } = await import('../session-verifier');
    expect(h.createSessionClient).toHaveBeenCalledTimes(1);
    const [config] = h.createSessionClient.mock.calls[0] as unknown as [
      CivitaiAuth.SessionClientConfig
    ];
    expect(config.verifiedTokenCache).toEqual({ maxEntries: 10_000, maxTtlMs: 60_000 });
    expect(config.isRevoked).toBe(isRevoked);
  });
});
