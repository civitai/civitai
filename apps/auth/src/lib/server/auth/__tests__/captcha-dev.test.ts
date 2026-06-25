import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// No `$app/environment` mock here → it uses the shared default (dev=true). This isolates the
// dev-bypass leg of isCaptchaEnabled (`!dev` is false in dev, so captcha is OFF even WITH a secret).
import { isCaptchaEnabled, verifyCaptchaToken } from '../captcha';

beforeEach(() => {
  process.env.CF_MANAGED_TURNSTILE_SECRET = 's3cret'; // secret set, but dev should still disable
});
afterEach(() => vi.unstubAllGlobals());

describe('captcha dev bypass', () => {
  it('is disabled in dev even when the secret is set', () => {
    expect(isCaptchaEnabled()).toBe(false);
  });

  it('verifyCaptchaToken passes through in dev (never hits Cloudflare)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await verifyCaptchaToken('whatever')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
