import { afterEach, describe, expect, it, vi } from 'vitest';
import { authProxy } from '~/utils/auth-proxy';

const respond = (status: number) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status }))
  );

afterEach(() => vi.unstubAllGlobals());

describe('authProxy.exitImpersonation', () => {
  it('resolves on a 410', async () => {
    respond(410);
    await expect(authProxy.exitImpersonation()).resolves.toBeUndefined();
  });

  it.each([403, 500])('throws on a %s', async (status) => {
    respond(status);
    await expect(authProxy.exitImpersonation()).rejects.toThrow();
  });
});
