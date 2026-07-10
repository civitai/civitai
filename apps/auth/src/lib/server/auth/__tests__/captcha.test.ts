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
  delete process.env.CF_MANAGED_TURNSTILE_SECRET;
  delete process.env.CF_MANAGED_TURNSTILE_SITEKEY;
  delete process.env.ORIGIN;
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CF_MANAGED_TURNSTILE_SECRET;
  delete process.env.CF_MANAGED_TURNSTILE_SITEKEY;
  delete process.env.ORIGIN;
});

// Stub a single Cloudflare siteverify outcome (the JSON body CF returns).
function stubSiteverify(outcome: Record<string, unknown>, status = 200) {
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify(outcome), { status }));
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

const HUB_ORIGIN = 'https://auth.civitai.com';
const HUB_HOST = 'auth.civitai.com';

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

  it('returns true on success + correct hostname + correct action', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret';
    process.env.ORIGIN = HUB_ORIGIN;
    const fetchSpy = stubSiteverify({ success: true, hostname: HUB_HOST, action: 'login' });
    expect(await verifyCaptchaToken('good-token', '1.2.3.4')).toBe(true);
    // sends secret + response + remoteip to the siteverify endpoint
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      secret: 's3cret',
      response: 'good-token',
      remoteip: '1.2.3.4',
    });
  });

  it('returns false (and logs) on a WRONG hostname — the cross-property replay gap', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret';
    process.env.ORIGIN = HUB_ORIGIN;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // token solved on the main app (shared sitekey+secret) reports civitai.com, not the hub host
    stubSiteverify({ success: true, hostname: 'civitai.com', action: 'login' });
    expect(await verifyCaptchaToken('replayed-token')).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(
      'captcha verify rejected',
      expect.objectContaining({ reason: 'hostname-mismatch', hostname: 'civitai.com' })
    );
  });

  it('returns false on a WRONG action', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret';
    process.env.ORIGIN = HUB_ORIGIN;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubSiteverify({ success: true, hostname: HUB_HOST, action: 'signup' });
    expect(await verifyCaptchaToken('wrong-action-token')).toBe(false);
  });

  it('returns false on a MISSING hostname (when ORIGIN is set)', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret';
    process.env.ORIGIN = HUB_ORIGIN;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubSiteverify({ success: true, action: 'login' }); // no hostname field
    expect(await verifyCaptchaToken('no-hostname-token')).toBe(false);
  });

  it('TOLERATES a MISSING action (still true) — an action-less token on the right host is a real user', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret';
    process.env.ORIGIN = HUB_ORIGIN;
    stubSiteverify({ success: true, hostname: HUB_HOST }); // no action field (e.g. stale pre-deploy tab)
    expect(await verifyCaptchaToken('no-action-token')).toBe(true);
  });

  it('TOLERATES an EMPTY-string action (still true) — the exact shape stale tabs produced in prod', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret';
    process.env.ORIGIN = HUB_ORIGIN;
    stubSiteverify({ success: true, hostname: HUB_HOST, action: '' });
    expect(await verifyCaptchaToken('empty-action-token')).toBe(true);
  });

  it('SKIPS the hostname check when ORIGIN is unset (still true on success + action)', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret';
    // ORIGIN deleted in beforeEach → expectedHostname() is undefined → hostname not enforced.
    stubSiteverify({ success: true, hostname: 'whatever.example', action: 'login' });
    expect(await verifyCaptchaToken('good-token')).toBe(true);
  });

  it('returns false (and logs error-codes) when Cloudflare reports success:false', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret';
    process.env.ORIGIN = HUB_ORIGIN;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubSiteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    expect(await verifyCaptchaToken('bad-token')).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(
      'captcha verify rejected',
      expect.objectContaining({
        reason: 'siteverify-failed',
        success: false,
        'error-codes': ['timeout-or-duplicate'],
      })
    );
  });

  it('returns false on a non-2xx siteverify response', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 's3cret';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    expect(await verifyCaptchaToken('good-token')).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(
      'captcha verify rejected',
      expect.objectContaining({ reason: 'siteverify-http', status: 500 })
    );
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

describe('verifyCaptchaToken — managed (interactive fallback) mode', () => {
  it('verifies against the MANAGED secret when mode=managed', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 'inv-secret';
    process.env.CF_MANAGED_TURNSTILE_SECRET = 'man-secret';
    const fetchSpy = stubSiteverify({ success: true, hostname: HUB_HOST, action: 'login' });
    expect(await verifyCaptchaToken('tok', undefined, { mode: 'managed' })).toBe(true);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).secret).toBe('man-secret');
  });

  it('defaults to the INVISIBLE secret when no mode is given', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 'inv-secret';
    process.env.CF_MANAGED_TURNSTILE_SECRET = 'man-secret';
    const fetchSpy = stubSiteverify({ success: true, hostname: HUB_HOST, action: 'login' });
    expect(await verifyCaptchaToken('tok')).toBe(true);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).secret).toBe('inv-secret');
  });

  it('fails closed (no network) when mode=managed but the managed secret is unset', async () => {
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 'inv-secret'; // captcha enabled, but no managed secret
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await verifyCaptchaToken('tok', undefined, { mode: 'managed' })).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
