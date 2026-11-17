import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Blocklist from '$lib/server/auth/blocklist';

const mocks = vi.hoisted(() => ({
  isBlockedEmailDomain: vi.fn(async (domain: string) => domain === 'blocked.test'),
  userExistsByEmail: vi.fn(async (email: string) => email === '"ada"@ok.test'),
  sendVerificationEmail: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/db/db', () => ({ db: {} }));
vi.mock('$lib/server/redis', () => ({ getRedis: () => null }));
vi.mock('$lib/server/auth/blocklist', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  isBlockedEmailDomain: mocks.isBlockedEmailDomain,
}));
vi.mock('$lib/server/auth/users', () => ({ userExistsByEmail: mocks.userExistsByEmail }));
vi.mock('$lib/server/email/verification.email', () => ({
  sendVerificationEmail: mocks.sendVerificationEmail,
}));
vi.mock('$lib/server/auth/email-tokens', () => ({
  createVerificationToken: vi.fn(async () => 'token'),
}));
vi.mock('$lib/server/auth/captcha', () => ({
  captchaSiteKey: () => null,
  captchaManagedSiteKey: () => null,
  isCaptchaEnabled: () => false,
  verifyCaptchaToken: vi.fn(async () => true),
}));
vi.mock('$lib/server/auth/rate-limit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('$lib/server/auth/request', () => ({ getClientIp: () => '203.0.113.1' }));
vi.mock('$lib/server/metrics', () => ({
  blockedEmailDomainSignupsTotal: { inc: vi.fn() },
  emailLoginFailuresTotal: { inc: vi.fn() },
}));
vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn() }));
vi.mock('$lib/server/tracking', () => ({ trackLoginRedirect: vi.fn() }));
vi.mock('$lib/server/auth/providers', () => ({ listEnabledProviders: () => [] }));
vi.mock('$lib/server/oauth/first-party', () => ({ buildPostLoginOriginCheck: vi.fn() }));

import { actions } from '../+page.server';

async function submit(email: string) {
  const form = new FormData();
  form.set('email', email);
  return actions.email({
    request: new Request('https://auth.civitai.com/login?/email', { method: 'POST', body: form }),
    url: new URL('https://auth.civitai.com/login'),
  } as never);
}

beforeEach(() => vi.clearAllMocks());

describe('magic-link sign-in accepts only plain email addresses', () => {
  it.each([
    'user@blocked.test(x).ok.test',
    'user@blocked.test .ok.test',
    '"user"@blocked.test',
    '"a@b"@ok.test',
    'Name <user@ok.test>',
    'a@ok.test, b@blocked.test',
    'user@blocked.tes\u0000t',
    'user@blocked.test\u0001.ok.test',
    'u@ｍａｉｌｉｎａｔｏｒ.test',
    'u@mail­inator.test',
    'u@mail​inator.test',
    'u@mailinator。test',
    'u@ⓜailinator.test',
    'u@bücher.de',
  ])('refuses %j as an invalid address and sends nothing', async (email) => {
    const result = await submit(email);

    expect(result).toMatchObject({ status: 400, data: { invalid: true } });
    expect(result).not.toMatchObject({ data: { blockedDomain: true } });
    expect(mocks.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('still refuses a plain address on a blocked domain with the blocked-domain error', async () => {
    const result = await submit('user@blocked.test');

    expect(result).toMatchObject({ status: 400, data: { blockedDomain: true } });
    expect(mocks.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it.each([
    'user@ok.test',
    'first.last+tag@sub.example.co.uk',
    'user@xn--bcher-kva.de',
    'First.Last@Example.COM',
    '  user@ok.test  ',
  ])('sends the link for %j', async (email) => {
    const result = await submit(email);

    expect(result).toMatchObject({ sent: true });
    expect(mocks.sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it('sends the link to a returning user whose address on file is not plain', async () => {
    const result = await submit('"ada"@ok.test');

    expect(result).toMatchObject({ sent: true });
    expect(mocks.sendVerificationEmail).toHaveBeenCalledWith('"ada"@ok.test', expect.any(String));
  });

  it('refuses a non-plain address that differs from the one on file', async () => {
    const result = await submit('"adb"@ok.test');

    expect(result).toMatchObject({ status: 400, data: { invalid: true } });
    expect(mocks.sendVerificationEmail).not.toHaveBeenCalled();
  });
});
