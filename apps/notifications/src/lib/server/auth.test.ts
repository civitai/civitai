import { afterEach, describe, expect, it, vi } from 'vitest';

// `notificationsToken` is read from process.env at module load, so each case resets modules + restubs
// the env, then imports a fresh copy of the gate.
async function loadGate(token: string) {
  vi.resetModules();
  vi.stubEnv('NOTIFICATIONS_TOKEN', token);
  return (await import('./auth')).isAuthorized;
}

afterEach(() => vi.unstubAllEnvs());

describe('isAuthorized', () => {
  it('is DISABLED (allows everything) when no token is configured', async () => {
    const isAuthorized = await loadGate('');
    expect(isAuthorized({})).toBe(true);
    expect(isAuthorized({ authorization: 'Bearer whatever' })).toBe(true);
  });

  describe('with a token configured', () => {
    it('allows a correct Bearer token', async () => {
      const isAuthorized = await loadGate('s3cret');
      expect(isAuthorized({ authorization: 'Bearer s3cret' })).toBe(true);
    });

    it('allows a correct x-webhook-token header', async () => {
      const isAuthorized = await loadGate('s3cret');
      expect(isAuthorized({ 'x-webhook-token': 's3cret' })).toBe(true);
    });

    it('rejects a wrong token', async () => {
      const isAuthorized = await loadGate('s3cret');
      expect(isAuthorized({ authorization: 'Bearer nope' })).toBe(false);
    });

    it('rejects a token of a different length (no timingSafeEqual throw)', async () => {
      const isAuthorized = await loadGate('s3cret');
      expect(isAuthorized({ authorization: 'Bearer s3' })).toBe(false);
    });

    it('rejects a missing token', async () => {
      const isAuthorized = await loadGate('s3cret');
      expect(isAuthorized({})).toBe(false);
    });

    it('ignores a non-Bearer authorization scheme', async () => {
      const isAuthorized = await loadGate('s3cret');
      expect(isAuthorized({ authorization: 'Basic s3cret' })).toBe(false);
    });
  });
});
