import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Captcha is "enabled" only when NOT in dev AND a secret is set. The shared `$app/environment` mock
// defaults dev=true, so override it to dev=false HERE to exercise the enabled path; the secret +
// sitekey come from `$env/dynamic/private` (process.env-backed). isCaptchaEnabled's dev-bypass leg
// is covered separately in captcha-dev.test.ts (which keeps the default dev=true).
vi.mock('$app/environment', () => ({ dev: false }));

// The Axiom sink is the breakdown an operator queries, so the rows it emits are assertable state, not a
// side effect to ignore. Stubbed rather than left live so a suite never writes to a real datastream.
const logToAxiom = vi.fn(async () => undefined);
vi.mock('$lib/server/axiom', () => ({
  logToAxiom: (...args: unknown[]) => logToAxiom(...(args as [])),
  logAxiomError: async () => undefined,
  safeError: (e: unknown) => ({ message: String(e) }),
}));

import { isCaptchaEnabled, captchaSiteKey, verifyCaptchaToken } from '../captcha';
import { register, captchaVerificationsTotal } from '$lib/server/metrics';

/** The single `captcha-reject` row a call emitted, or undefined when it emitted none. */
const rejectRow = () =>
  logToAxiom.mock.calls.map((c) => (c as unknown as [Record<string, unknown>])[0]).at(-1);

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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    );
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

// Every sample of hub_captcha_verifications_total with its FULL label set. Asserting the whole set (not a
// subset) is the point: an inc that omits `mode` still exports — prom-client drops the label instead of
// throwing — so a subset match would pass over exactly the defect these tests exist to catch.
async function captchaSamples(): Promise<{ labels: Record<string, string>; value: number }[]> {
  const metric = (await register.getMetricsAsJSON()).find(
    (m) => m.name === 'hub_captcha_verifications_total'
  );
  return (metric?.values ?? []).map((v) => ({
    labels: (v.labels ?? {}) as Record<string, string>,
    value: v.value,
  }));
}

// Two properties per case, and the closure in verifyCaptchaToken only makes the second structural:
// the `result` SPELLING each branch records (the dash→underscore mapping especially), and that the
// `mode` travelling with it is the one the caller asked for rather than a default.
describe('captcha verification counter — result x widget mode', () => {
  beforeEach(() => {
    captchaVerificationsTotal.reset();
    process.env.CF_INVISIBLE_TURNSTILE_SECRET = 'inv-secret';
    process.env.ORIGIN = HUB_ORIGIN;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('counts a SUCCESS from the invisible widget as mode=invisible', async () => {
    stubSiteverify({ success: true, hostname: HUB_HOST, action: 'login' });
    expect(await verifyCaptchaToken('tok')).toBe(true);
    expect(await captchaSamples()).toEqual([
      { labels: { result: 'success', mode: 'invisible' }, value: 1 },
    ]);
  });

  it('counts a SUCCESS from the interactive fallback as mode=managed', async () => {
    process.env.CF_MANAGED_TURNSTILE_SECRET = 'man-secret';
    stubSiteverify({ success: true, hostname: HUB_HOST, action: 'login' });
    expect(await verifyCaptchaToken('tok', undefined, { mode: 'managed' })).toBe(true);
    expect(await captchaSamples()).toEqual([
      { labels: { result: 'success', mode: 'managed' }, value: 1 },
    ]);
  });

  it('counts no_token with the mode the submit claimed', async () => {
    expect(await verifyCaptchaToken(undefined, undefined, { mode: 'managed' })).toBe(false);
    expect(await verifyCaptchaToken(undefined)).toBe(false);
    expect(await captchaSamples()).toEqual([
      { labels: { result: 'no_token', mode: 'managed' }, value: 1 },
      { labels: { result: 'no_token', mode: 'invisible' }, value: 1 },
    ]);
  });

  it('counts no_secret as mode=managed (the only mode that can reach it)', async () => {
    // Invisible secret set, managed one absent → a managed submit has nothing to verify against.
    expect(await verifyCaptchaToken('tok', undefined, { mode: 'managed' })).toBe(false);
    expect(await captchaSamples()).toEqual([
      { labels: { result: 'no_secret', mode: 'managed' }, value: 1 },
    ]);
  });

  it('counts http_error with the mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    );
    expect(await verifyCaptchaToken('tok')).toBe(false);
    expect(await captchaSamples()).toEqual([
      { labels: { result: 'http_error', mode: 'invisible' }, value: 1 },
    ]);
  });

  it('carries the mode into the http_error Axiom row too, not only the counter', async () => {
    // A verification outage that answers 500 rather than refusing the connection lands here, so this is
    // the reject the mode split most needs to be able to break down. The counter gets `mode` from the
    // shared assembly site; the Axiom row is hand-built and had no such binding.
    process.env.CF_MANAGED_TURNSTILE_SECRET = 'man-secret';
    logToAxiom.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    );
    expect(await verifyCaptchaToken('tok', undefined, { mode: 'managed' })).toBe(false);
    expect(rejectRow()).toMatchObject({ reason: 'http_error', mode: 'managed' });
  });

  it('counts one verification once, even when a sink throws after the count', async () => {
    // The outer catch counts now, so a throw from a log line after a branch has already counted would
    // record the same verification twice under two different results.
    logToAxiom.mockImplementationOnce(() => {
      throw new Error('axiom exploded');
    });
    stubSiteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    expect(await verifyCaptchaToken('tok')).toBe(false);
    expect(await captchaSamples()).toEqual([
      { labels: { result: 'siteverify_failed', mode: 'invisible' }, value: 1 },
    ]);
    logToAxiom.mockImplementation(async () => undefined);
  });

  it('counts siteverify_failed with the mode', async () => {
    stubSiteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    expect(await verifyCaptchaToken('tok')).toBe(false);
    expect(await captchaSamples()).toEqual([
      { labels: { result: 'siteverify_failed', mode: 'invisible' }, value: 1 },
    ]);
  });

  it('counts hostname_mismatch with the mode', async () => {
    process.env.CF_MANAGED_TURNSTILE_SECRET = 'man-secret';
    stubSiteverify({ success: true, hostname: 'civitai.com', action: 'login' });
    expect(await verifyCaptchaToken('tok', undefined, { mode: 'managed' })).toBe(false);
    expect(await captchaSamples()).toEqual([
      { labels: { result: 'hostname_mismatch', mode: 'managed' }, value: 1 },
    ]);
  });

  it('counts a siteverify NETWORK failure, with the mode', async () => {
    // Uncounted, this class is invisible: an upstream verification outage shows as a volume drop with
    // no reason beside it, inside the denominator the mode split is read against.
    process.env.CF_MANAGED_TURNSTILE_SECRET = 'man-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );
    expect(await verifyCaptchaToken('tok', undefined, { mode: 'managed' })).toBe(false);
    expect(await captchaSamples()).toEqual([
      { labels: { result: 'verify_error', mode: 'managed' }, value: 1 },
    ]);
  });

  it('counts a MALFORMED siteverify body as the same class', async () => {
    // A 200 that is not JSON throws out of res.json(), inside the same try — same outage, same reason.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502</html>', { status: 200 }))
    );
    expect(await verifyCaptchaToken('tok')).toBe(false);
    expect(await captchaSamples()).toEqual([
      { labels: { result: 'verify_error', mode: 'invisible' }, value: 1 },
    ]);
  });

  it('logs the network failure, without the token or the secret', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );
    expect(await verifyCaptchaToken('tok-abc')).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(
      'captcha verify rejected',
      expect.objectContaining({ reason: 'verify_error', error: 'network down' })
    );
    // The reject log is the one place a caught exception could carry credentials into an aggregator.
    const logged = JSON.stringify(errSpy.mock.calls);
    expect(logged).not.toContain('tok-abc');
    expect(logged).not.toContain('inv-secret');
  });

  it('counts action_mismatch with the mode', async () => {
    stubSiteverify({ success: true, hostname: HUB_HOST, action: 'signup' });
    expect(await verifyCaptchaToken('tok')).toBe(false);
    expect(await captchaSamples()).toEqual([
      { labels: { result: 'action_mismatch', mode: 'invisible' }, value: 1 },
    ]);
  });

  // The dashboard aggregates `sum by (result) (rate(hub_captcha_verifications_total[5m]))`, so the
  // metric name and the `result` label are a contract with a consumer outside this repo: this pins
  // the whole label set, so dropping `result` or renaming the metric fails here by name rather than
  // as a confusing empty-sample assertion elsewhere. Asserted on the label SET, not the exposition
  // string — prom-client emits labels in insertion order, so a string match would go red for
  // reordering `{ result, mode }`, which no consumer can observe.
  it('keeps the metric name and the result label (external consumers aggregate on them)', async () => {
    stubSiteverify({ success: true, hostname: HUB_HOST, action: 'login' });
    await verifyCaptchaToken('tok');
    const samples = await captchaSamples(); // empty if the metric were renamed
    expect(samples).toHaveLength(1);
    expect(Object.keys(samples[0].labels).sort()).toEqual(['mode', 'result']);
  });
});
