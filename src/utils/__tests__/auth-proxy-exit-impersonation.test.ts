import { afterEach, describe, expect, it, vi } from 'vitest';
import { authProxy } from '~/utils/auth-proxy';

const respond = (status: number) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status }))
  );

afterEach(() => vi.unstubAllGlobals());

describe('authProxy.exitImpersonation', () => {
  it('resolves on a 403, as the hub has already ended the session', async () => {
    respond(403);
    await expect(authProxy.exitImpersonation()).resolves.toBeUndefined();
  });

  it('still throws on any other failure', async () => {
    respond(500);
    await expect(authProxy.exitImpersonation()).rejects.toThrow();
  });
});
