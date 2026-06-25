import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Captcha is "enabled" only when NOT in dev AND a secret is set. The shared `$app/environment` mock
// defaults dev=true, so override it to dev=false HERE to exercise the enabled path; the secret +
// sitekey come from `$env/dynamic/private` (process.env-backed). isCaptchaEnabled's dev-bypass leg
// is covered separately in captcha-dev.test.ts (which keeps the default dev=true).
vi.mock('$app/environment', () => ({ dev: false }));

import { isCaptchaEnabled, captchaSiteKey, verifyCaptchaToken } from '../captcha';

beforeEach(() => {
  delete process.env.CF_INVISIBLE_TURNSTILE_SECRET;
  delete process.env.CF_INVISIBLE_TURNSTILE_SITEKEY;
  vi.restoreAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('isCaptchaEnabled (not dev)', () => {
  it('disabled when the secret is unset', () => {
    expect(isCaptchaEnabled()).toBe(false);
  });
  it('enabled when the secret is set', () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret';
    expect(isCaptchaEnabled()).toBe(true);
  });
});

describe('captchaSiteKey', () => {
  it('returns the key when set, undefined otherwise', () => {
    expect(captchaSiteKey()).toBeUndefined();
    process.env.CF_INVISIBLE_TURNSTILE_SITEKEY = 'site-key';
    expect(captchaSiteKey()).toBe('site-key');
  });
  it('coerces an empty-string key to undefined (no widget rendered)', () => {
    process.env.CF_INVISIBLE_TURNSTILE_SITEKEY = '';
    expect(captchaSiteKey()).toBeUndefined();
  });
});

describe('verifyCaptchaToken', () => {
  it('passes through (true) when captcha is disabled, without calling fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // secret unset → disabled → bypass
    expect(await verifyCaptchaToken('any-token')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed (false) on a missing token when enabled', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await verifyCaptchaToken(undefined)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled(); // short-circuits before the network call
  });

  it('returns true on a successful Cloudflare siteverify', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret';
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ success: true }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchSpy);
    expect(await verifyCaptchaToken('good-token', '1.2.3.4')).toBe(true);
    // sends secret + response + remoteip to the siteverify endpoint
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      secret: 's3cret',
      response: 'good-token',
      remoteip: '1.2.3.4',
    });
  });

  it('returns false when Cloudflare reports success:false', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 }))
    );
    expect(await verifyCaptchaToken('bad-token')).toBe(false);
  });

  it('returns false on a non-2xx siteverify response', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    expect(await verifyCaptchaToken('good-token')).toBe(false);
  });

  it('returns false (fail-closed) when fetch throws', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );
    expect(await verifyCaptchaToken('good-token')).toBe(false);
  });
});
