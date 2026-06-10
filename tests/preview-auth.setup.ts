import { test as setup } from '@playwright/test';
import fs from 'fs';
import { encode } from 'next-auth/jwt';
import { v4 as uuid } from 'uuid';
import { PREVIEW_USERS, type PreviewRole, storageStatePath } from './preview-fixtures';

/**
 * Preview-environment auth setup.
 *
 * A deployed PR preview (IS_PREVIEW=true) is gated by preview-auth.middleware:
 * unauthenticated -> /login, moderators pass, other logged-in users pass only
 * if the Flipt `preview-site-access` `testers` segment matches them. The local
 * `/testing/testing-login` flow (tests/auth.setup.ts) is DEAD against a preview
 * because previews run NODE_ENV=production, which disables both the
 * `testing-login` credentials provider and the `/testing/*` route.
 *
 * Instead we mint the NextAuth session cookie directly with the preview's
 * shared NEXTAUTH_SECRET — the same `encode()` the app signs with, so JWE parity
 * is guaranteed. Two distinct things then happen, and the distinction matters:
 *   1. The GATE (preview-auth.middleware) reads `token.user` straight from the
 *      cookie (no DB hit) — so the MINTED `id`/`isModerator` are what clear it.
 *   2. SSR page renders call the session() callback → refreshToken(), which sees
 *      an untracked token id and refreshes `token.user` from the DB
 *      (getSessionUser). So past the gate, the SEEDED DB row — not the minted
 *      fields — is the authoritative session user.
 * Net: the minted cookie authenticates as the seeded user. The minted object
 * below only needs `id` + `isModerator` (+ `tier` for the gate's Flipt context);
 * the rest is informational and is superseded by the DB row on first render. The
 * backing User rows (and the gold subscription) are seeded into cnpg-cluster-dev
 * by the datapacket-talos `seed-smoke-test-users` CronJob; ci-smoke-tester /
 * ci-smoke-gold are in the flipt `testers` allowlist so they pass the gate.
 *
 * Only runs in the preview Playwright config (playwright.preview.config.ts);
 * the default config ignores `preview-*` files.
 */

const SECRET = process.env.NEXTAUTH_SECRET;
const PREVIEW_URL = process.env.PREVIEW_URL;
const COOKIE_NAME = '__Secure-civitai-token'; // libs/auth.ts — https preview => __Secure- prefix
const MAX_AGE_S = 30 * 24 * 60 * 60;

async function mintStorageState(role: PreviewRole): Promise<string> {
  const u = PREVIEW_USERS[role];

  // token.user shape (ExtendedUser, src/types/next-auth.d.ts). id + isModerator
  // drive the gate; the rest matches the seeded DB row so SSR treats it as a
  // real logged-in user. ci-smoke-mod is the only moderator.
  const user = {
    id: u.id,
    username: u.username,
    email: `${u.username}@civitai.test`,
    isModerator: u.isModerator,
    tier: u.tier,
    showNsfw: true,
    blurNsfw: false,
    browsingLevel: 1,
    onboarding: 15, // OnboardingComplete (TOS|Profile|BrowsingLevels|Buzz)
    muted: false,
  };

  const token = { user, sub: String(u.id), id: uuid(), signedAt: Date.now() };
  const value = await encode({ token, secret: SECRET as string, maxAge: MAX_AGE_S });

  const { hostname } = new URL(PREVIEW_URL as string);
  const storageState = {
    cookies: [
      {
        name: COOKIE_NAME,
        value,
        domain: hostname,
        path: '/',
        expires: Math.floor(Date.now() / 1000) + MAX_AGE_S,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax' as const,
      },
    ],
    origins: [],
  };

  fs.mkdirSync('tests/auth', { recursive: true });
  fs.writeFileSync(storageStatePath(role), JSON.stringify(storageState, null, 2));
  return value;
}

setup('mint preview sessions', async ({ request }) => {
  if (!SECRET) throw new Error('NEXTAUTH_SECRET is required to mint preview sessions');
  if (!PREVIEW_URL) throw new Error('PREVIEW_URL is required for preview smoke tests');
  const jwts: Partial<Record<PreviewRole, string>> = {};
  for (const role of Object.keys(PREVIEW_USERS) as PreviewRole[]) {
    jwts[role] = await mintStorageState(role);
  }

  // Warm the freshly-deployed preview before the suite so the first real test
  // doesn't pay the full cold-SSR cost (Next warm-up + JIT + DB pools). Warm the
  // HEAVY listing pages too, not just `/` — those are the slow ones. They must be
  // warmed AUTHENTICATED: on a preview the gate 307s an UNauthenticated /models to
  // /login, so an anon GET wouldn't touch the real /models render path. Use the
  // gold (gate-passing) cookie. Sequential + non-fatal; the suite + retries cover
  // any miss.
  const gold = jwts.gold;
  if (gold) {
    const headers = { cookie: `${COOKIE_NAME}=${gold}` };
    for (const path of ['/', '/models', '/images']) {
      await request.get(path, { timeout: 60_000, headers }).catch(() => {});
    }
  }
});
