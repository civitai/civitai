import { test, expect, type Page } from '@playwright/test';

/**
 * Hub login-START tests (UNAUTHENTICATED — run against any live hub, no trusted key needed).
 *
 * Covers the OAuth authorize redirect that begins every social login: GET /login/<provider> must 302 to the
 * upstream provider's authorize endpoint carrying response_type=code, a scope, PKCE (code_challenge + S256), a
 * CSRF state, and our /callback redirect_uri. This is the runtime complement to the buildAuthorizeUrl unit test
 * (apps/auth/.../__tests__/authorize-url.test.ts) and the one path the identity-focused hub-smoke spec omits.
 */

// Provider config is env-per-deploy, so discover an enabled OAuth provider from /login rather than hard-coding.
// (email is a magic-link provider, not an authorize redirect — excluded.)
async function firstEnabledOAuthProvider(page: Page): Promise<string | null> {
  await page.goto('/login');
  const body = (await page.textContent('body'))?.toLowerCase() ?? '';
  return ['discord', 'google', 'github', 'reddit'].find((p) => body.includes(p)) ?? null;
}

test.describe('hub — login start (authorize redirect)', () => {
  test('GET /login/<provider> redirects to the upstream authorize URL with PKCE + scope', async ({
    page,
    playwright,
    baseURL,
  }) => {
    const provider = await firstEnabledOAuthProvider(page);
    test.skip(!provider, 'no OAuth provider configured on this hub');

    // Inspect the 302 WITHOUT following it (the target is the external provider). The handler stashes
    // state/PKCE in cookies and redirects, so a plain cookieless GET is enough.
    const ctx = await playwright.request.newContext({ baseURL });
    try {
      const res = await ctx.get(`/login/${provider}`, { maxRedirects: 0 });
      expect(res.status(), 'authorize start should redirect').toBeGreaterThanOrEqual(300);
      expect(res.status(), 'authorize start should redirect').toBeLessThan(400);

      const location = res.headers()['location'] ?? '';
      expect(location, 'should set an authorize Location').not.toBe('');
      const url = new URL(location);
      expect(url.searchParams.get('response_type'), 'OAuth code flow').toBe('code');
      expect(url.searchParams.get('code_challenge_method'), 'PKCE S256').toBe('S256');
      expect(url.searchParams.get('code_challenge'), 'PKCE challenge present').toBeTruthy();
      expect(url.searchParams.get('state'), 'CSRF state present').toBeTruthy();
      expect(url.searchParams.get('scope'), 'scope requested').toBeTruthy();
      expect(url.searchParams.get('redirect_uri'), 'callback uri present').toContain('/callback');
    } finally {
      await ctx.dispose();
    }
  });
});
