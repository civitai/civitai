import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// No `$app/environment` mock here → it uses the shared default (dev=true). This isolates the dev legs of
// isCaptchaEnabled: OFF by default even WITH a secret, but ON when CAPTCHA_DEV opts into the CF test keys.
import {
  isCaptchaEnabled,
  verifyCaptchaToken,
  captchaSiteKey,
  captchaManagedSiteKey,
} from '../captcha';

beforeEach(() => {
  process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret'; // secret set, but dev disables unless CAPTCHA_DEV opts in
  delete process.env.CAPTCHA_DEV;
  delete process.env.CF_INVISIBLE_TURNSTILE_SITEKEY;
  delete process.env.CF_MANAGED_TURNSTILE_SITEKEY;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CAPTCHA_DEV;
  delete process.env.CF_INVISIBLE_TURNSTILE_SITEKEY;
  delete process.env.CF_MANAGED_TURNSTILE_SITEKEY;
});

describe('captcha dev bypass (default)', () => {
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

describe('captcha dev opt-in (CAPTCHA_DEV=true → CF test keys)', () => {
  beforeEach(() => {
    process.env.CAPTCHA_DEV = 'true';
    // Real dev scenario: no account keys set, so the CF test-key defaults are exercised.
    delete process.env.CF_INVISIBLE_TURNSTILE_SECRET;
    delete process.env.CF_MANAGED_TURNSTILE_SECRET;
  });

  it('enables captcha in dev', () => {
    expect(isCaptchaEnabled()).toBe(true);
  });

  it('serves the CF test sitekeys (invisible always-pass + managed forced-challenge)', () => {
    expect(captchaSiteKey()).toBe('1x00000000000000000000BB');
    expect(captchaManagedSiteKey()).toBe('3x00000000000000000000FF');
  });

  it('real env sitekeys still override the test keys', () => {
    process.env.CF_INVISIBLE_TURNSTILE_SITEKEY = 'real-invisible';
    process.env.CF_MANAGED_TURNSTILE_SITEKEY = 'real-managed';
    expect(captchaSiteKey()).toBe('real-invisible');
    expect(captchaManagedSiteKey()).toBe('real-managed');
  });

  it('verifies a token against Cloudflare using the dummy test secret', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    expect(await verifyCaptchaToken('test-token')).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).secret).toBe('1x0000000000000000000000000000000AA');
  });
});
