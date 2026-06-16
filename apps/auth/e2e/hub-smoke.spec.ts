import { test, expect } from '@playwright/test';
import fs from 'fs';
import { HUB_USERS, storageStatePath, mintModePath, type MintMode } from './hub-fixtures';

/**
 * Hub smoke suite — runs against a DEPLOYED hub at HUB_URL (see playwright.hub.config.ts).
 *
 * Split into UNAUTHENTICATED assertions (always run; work against any live hub, incl. the
 * dev-key auth.civitai.com today) and AUTHENTICATED identity assertions (run only when
 * hub-auth.setup.ts minted with a hub-TRUSTED key — see mint-mode.json).
 */

function mintMode(): MintMode | null {
  try {
    return JSON.parse(fs.readFileSync(mintModePath, 'utf8')) as MintMode;
  } catch {
    return null;
  }
}

test.describe('hub — unauthenticated', () => {
  test('GET /api/health → 200 {status:ok}', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  test('GET /api/auth/jwks serves a usable signing key', async ({ request }) => {
    const res = await request.get('/api/auth/jwks');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys.length).toBeGreaterThan(0);
    const k = body.keys[0];
    // ES256 EC P-256 verification key, labelled for rotation, marked for signature use.
    expect(k).toMatchObject({ kty: 'EC', use: 'sig', alg: 'ES256' });
    expect(typeof k.kid).toBe('string');
    expect(k.x && k.y).toBeTruthy();
    // No private material must ever be served.
    expect(k.d).toBeUndefined();
  });

  test('GET /login renders the configured provider options', async ({ page }) => {
    await page.goto('/login');
    // A provider button renders only when its CLIENT_ID + SECRET are both set. We assert at least
    // one upstream option is present rather than a fixed set (provider config is env-per-deploy).
    const body = (await page.textContent('body'))?.toLowerCase() ?? '';
    const providers = ['discord', 'google', 'github', 'reddit', 'email'];
    expect(providers.some((p) => body.includes(p))).toBe(true);
  });
});

test.describe('hub — authenticated identity', () => {
  // Only meaningful when the minted cookie is signed with a key the hub trusts.
  test.skip(() => !mintMode()?.trusted, 'minted with an ephemeral (untrusted) key — see e2e/README.md');

  test('GET /api/auth/identity resolves the seeded tester via the session cookie', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath('tester') });
    try {
      const res = await ctx.request.get('/api/auth/identity');
      // The hub verifies the cookie (trusted key) then resolves the user from the seeded DB row.
      expect(res.status()).toBe(200);
      const user = await res.json();
      expect(user.id).toBe(HUB_USERS.tester.id);
    } finally {
      await ctx.close();
    }
  });

  test('GET /api/auth/identity is unauthorized without a session cookie', async ({ request }) => {
    const res = await request.get('/api/auth/identity');
    expect(res.status()).toBe(401);
  });
});
