import { request, type Browser, type BrowserContext } from '@playwright/test';
import { SESSION_COOKIE_BASE } from '../../packages/civitai-auth/src/constants';
import { e2eEnv } from './env';

const tokenCache = new Map<number, string>();

async function mintSessionToken(userId: number): Promise<string> {
  const cached = tokenCache.get(userId);
  if (cached) return cached;
  const env = e2eEnv();
  const res = await fetch(`${env.TEXT_SCAN_E2E_HUB_URL}/api/auth/dev/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.AUTH_INTERNAL_TOKEN}`,
    },
    body: JSON.stringify({ userId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok)
    throw new Error(
      `hub dev login for user ${userId} -> HTTP ${res.status}. The hub must run under vite dev with the same AUTH_INTERNAL_TOKEN.`
    );
  const { token } = (await res.json()) as { token: string };
  tokenCache.set(userId, token);
  return token;
}

// Unprefixed and not Secure: the `__Secure-` prefix applies only on an https origin.
async function cookiesFor(userId: number) {
  const env = e2eEnv();
  const value = await mintSessionToken(userId);
  const origins = new Set([
    new URL(env.TEXT_SCAN_E2E_BASE_URL).origin,
    new URL(env.TEXT_SCAN_E2E_MODERATOR_URL).origin,
  ]);
  return [...origins].map((url) => ({
    name: SESSION_COOKIE_BASE,
    value,
    url,
    httpOnly: true,
    secure: false,
    sameSite: 'Lax' as const,
  }));
}

export async function contextFor(browser: Browser, userId: number): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies(await cookiesFor(userId));
  return context;
}

/** Origin/Referer satisfy the tRPC CSRF gate for cookie-authed requests. */
export async function apiFor(userId: number | null) {
  const env = e2eEnv();
  const origin = new URL(env.TEXT_SCAN_E2E_BASE_URL).origin;
  const cookies =
    userId == null
      ? []
      : (await cookiesFor(userId)).map(({ url, ...c }) => ({
          ...c,
          domain: new URL(url).hostname,
          path: '/',
          expires: -1,
        }));
  return request.newContext({
    baseURL: env.TEXT_SCAN_E2E_BASE_URL,
    storageState: { cookies, origins: [] },
    extraHTTPHeaders: { origin, referer: `${origin}/` },
    timeout: 180_000,
  });
}
