import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The hub's outbound calls made inside a sign-in request — Turnstile siteverify, the OAuth token exchange
// and the profile fetch — must give up on an upstream that never answers, instead of holding the request
// for undici's 300 s header timeout. The fetch stub never settles on its own; it rejects only when the
// caller's signal aborts, as real fetch does.

vi.mock('$app/environment', () => ({ dev: false }));
vi.mock('$lib/server/axiom', () => ({
  logToAxiom: vi.fn(async () => undefined),
  logAxiomError: async () => undefined,
  safeError: (e: unknown) => ({ message: String(e) }),
}));

import { verifyCaptchaToken } from '../captcha';
import { exchangeCode, fetchProfile } from '../providers';

let calls = 0;
function hungFetch(_url: unknown, init?: RequestInit): Promise<Response> {
  calls++;
  return new Promise((_, reject) => {
    const signal = init?.signal;
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
      once: true,
    });
  });
}

async function within<T>(ms: number, run: () => Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<'hung'>((r) => (timer = setTimeout(() => r('hung'), ms)));
  try {
    return await Promise.race([
      run().then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      ),
      hung,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const provider = {
  id: 'github',
  name: 'GitHub',
  tokenUrl: 'https://provider.example.test/token',
  userinfoUrl: 'https://provider.example.test/user',
  clientId: () => 'id',
  clientSecret: () => 'secret',
  mapProfile: (json: Record<string, unknown>) => json,
} as never;

beforeEach(() => {
  calls = 0;
  vi.stubGlobal('fetch', hungFetch);
  process.env.CF_INVISIBLE_TURNSTILE_SECRET = 'secret';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CF_INVISIBLE_TURNSTILE_SECRET;
});

describe('outbound calls against an upstream that never answers', () => {
  it('captcha verification fails closed within 6 s', async () => {
    const started = Date.now();
    const res = await within(12_000, () => verifyCaptchaToken('token', '1.2.3.4'));
    expect(res).toEqual({ value: false });
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 20_000);

  it('the OAuth token exchange rejects within 11 s', async () => {
    const started = Date.now();
    const res = await within(15_000, () =>
      exchangeCode(provider, { code: 'c', redirectUri: 'https://auth.test/cb' })
    );
    expect(res).not.toBe('hung');
    expect(res).toHaveProperty('error');
    expect(Date.now() - started).toBeLessThan(11_000);
  }, 20_000);

  it('the profile fetch rejects within 11 s', async () => {
    const started = Date.now();
    const res = await within(15_000, () => fetchProfile(provider, 'access-token'));
    expect(res).not.toBe('hung');
    expect(res).toHaveProperty('error');
    expect(Date.now() - started).toBeLessThan(11_000);
  }, 20_000);
});
