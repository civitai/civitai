import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ lastMethod: 'github' as string | undefined }));

vi.mock('$lib/server/db/db', () => ({ db: {} }));
vi.mock('$lib/server/redis', () => ({ getRedis: () => null }));
vi.mock('$lib/server/auth/users', () => ({ userExistsByEmail: vi.fn() }));
vi.mock('$lib/server/email/verification.email', () => ({ sendVerificationEmail: vi.fn() }));
vi.mock('$lib/server/auth/email-tokens', () => ({ createVerificationToken: vi.fn() }));
vi.mock('$lib/server/auth/captcha', () => ({
  captchaSiteKey: () => null,
  captchaManagedSiteKey: () => null,
  isCaptchaEnabled: () => false,
  verifyCaptchaToken: vi.fn(),
}));
vi.mock('$lib/server/auth/rate-limit', () => ({ consumeRateLimit: vi.fn() }));
vi.mock('$lib/server/auth/request', () => ({ getClientIp: () => null }));
vi.mock('$lib/server/metrics', () => ({
  blockedEmailDomainSignupsTotal: { inc: vi.fn() },
  emailLoginFailuresTotal: { inc: vi.fn() },
}));
vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn(), logToAxiom: vi.fn() }));
vi.mock('$lib/server/tracking', () => ({ trackLoginRedirect: vi.fn() }));
vi.mock('$lib/server/auth/providers', () => ({
  listEnabledProviders: () => [
    { id: 'discord', name: 'Discord' },
    { id: 'github', name: 'GitHub' },
  ],
}));
vi.mock('@civitai/email', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isEmailConfigured: () => true,
}));
vi.mock('$lib/server/oauth/first-party', () => ({ buildPostLoginOriginCheck: vi.fn() }));

import { load } from '../+page.server';
import { lastMethodCookieName } from '$lib/server/auth/last-method';

async function lastMethodShown(query = '') {
  const data = (await load({
    url: new URL(`https://auth.civitai.com/login${query}`),
    locals: {},
    request: new Request('https://auth.civitai.com/login'),
    cookies: {
      get: (name: string) => (name === lastMethodCookieName() ? h.lastMethod : undefined),
    },
  } as never)) as { lastMethod: string | null };
  return data.lastMethod;
}

beforeEach(() => {
  h.lastMethod = 'github';
});

describe('the "Last used" badge on the login page', () => {
  it('names the method this browser last signed in with', async () => {
    expect(await lastMethodShown()).toBe('github');
    h.lastMethod = 'email';
    expect(await lastMethodShown()).toBe('email');
  });

  it.each(['reddit', 'myspace', 'github"><b>', 'someone@example.com'])(
    'shows nothing for %j, which is not an enabled method',
    async (value) => {
      h.lastMethod = value;
      expect(await lastMethodShown()).toBeNull();
    }
  );

  it.each(['?prompt=select_account', '?reason=switch-accounts'])(
    'shows nothing when adding an account (%s)',
    async (query) => {
      expect(await lastMethodShown(query)).toBeNull();
    }
  );
});
