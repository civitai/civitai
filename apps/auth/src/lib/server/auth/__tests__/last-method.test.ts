import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  providers: [{ id: 'discord' }, { id: 'github' }] as { id: string }[],
  emailConfigured: true,
}));
vi.mock('../providers', () => ({ listEnabledProviders: () => h.providers }));
vi.mock('@civitai/email', () => ({ isEmailConfigured: () => h.emailConfigured }));
vi.mock('../../axiom', () => ({ logToAxiom: vi.fn() }));

const { lastMethodCookieName, readLastMethod, rememberLastMethod } = await import('../last-method');

const jar = (value?: string) => ({
  get: (name: string) => (name === lastMethodCookieName() ? value : undefined),
});

beforeEach(() => {
  h.providers = [{ id: 'discord' }, { id: 'github' }];
  h.emailConfigured = true;
});

describe('readLastMethod', () => {
  it('returns an enabled provider, or email when email sign-in is on', () => {
    expect(readLastMethod(jar('github'))).toBe('github');
    expect(readLastMethod(jar('email'))).toBe('email');
  });

  it.each([
    ['an unknown method', 'myspace'],
    ['a tampered value', 'github<script>'],
    ['an address', 'someone@example.com'],
    ['nothing', undefined],
  ])('ignores %s', (_, value) => {
    expect(readLastMethod(jar(value))).toBeNull();
  });

  it('ignores a provider that has since been turned off', () => {
    h.providers = [{ id: 'discord' }];
    expect(readLastMethod(jar('github'))).toBeNull();
  });

  it('ignores email when email sign-in is off', () => {
    h.emailConfigured = false;
    expect(readLastMethod(jar('email'))).toBeNull();
  });
});

describe('rememberLastMethod', () => {
  afterEach(() => {
    delete process.env.AUTH_JWT_ISSUER;
  });

  it('writes a host-only, year-plus cookie on https', () => {
    process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
    const cookies = { set: vi.fn() };
    rememberLastMethod(cookies, 'google');
    expect(cookies.set).toHaveBeenCalledWith('__Host-civ_last_method', 'google', {
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 34_560_000,
    });
  });

  it('uses the bare name on http, where __Host- cookies are refused', () => {
    process.env.AUTH_JWT_ISSUER = 'http://localhost:5173';
    const cookies = { set: vi.fn() };
    rememberLastMethod(cookies, 'email');
    expect(cookies.set.mock.calls[0][0]).toBe('civ_last_method');
  });

  it.each(['someone@example.com', '42 ', 'GitHub', ''])('never stores %j', (value) => {
    const cookies = { set: vi.fn() };
    rememberLastMethod(cookies, value);
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it('stores only lowercase ids, never an address', () => {
    const cookies = { set: vi.fn() };
    for (const m of ['discord', 'github', 'google', 'reddit', 'email', 'stub'])
      rememberLastMethod(cookies, m);
    for (const [, value] of cookies.set.mock.calls) {
      expect(value).toMatch(/^[a-z0-9_-]+$/);
      expect(value).not.toContain('@');
    }
    expect(cookies.set).toHaveBeenCalledTimes(6);
  });
});
