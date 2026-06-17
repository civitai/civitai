import { test as setup } from '@playwright/test';
import fs from 'fs';
import { EncryptJWT } from 'jose';
import { hkdfSync } from 'node:crypto';
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

// Mint the LEGACY next-auth v4 session cookie (a `dir`/`A256GCM` JWE, HKDF-derived key) WITHOUT next-auth, which
// is now removed. The app still ACCEPTS it via @civitai/auth's decodeLegacySessionCookie during the cutover, so
// this mirrors that decoder's key derivation exactly.
const ENC_INFO = 'NextAuth.js Generated Encryption Key';
const derivedKey = (secret: string) => new Uint8Array(hkdfSync('sha256', secret, '', ENC_INFO, 32));

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
  const value = await new EncryptJWT(token)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + MAX_AGE_S)
    .encrypt(derivedKey(SECRET as string));

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
  // This setup runs the cold-pod warm-up below: ~9 SEQUENTIAL heavy-SSR GETs (each
  // capped at 60s) so one route compiles at a time (parallel heavy renders OOM the
  // single-replica pod). On a genuinely cold pod the cumulative warm-up can exceed
  // the suite's 90s per-test timeout — and a setup timeout SKIPS every dependent
  // smoke test (worse than the flake we're fixing). So give just this setup a large
  // ceiling. It's a CEILING, not the runtime: the setup still finishes as fast as
  // the warm-ups actually take (~2s when the pod is already warm from verify-preview).
  setup.setTimeout(480_000);
  if (!SECRET) throw new Error('NEXTAUTH_SECRET is required to mint preview sessions');
  if (!PREVIEW_URL) throw new Error('PREVIEW_URL is required for preview smoke tests');
  const jwts: Partial<Record<PreviewRole, string>> = {};
  for (const role of Object.keys(PREVIEW_USERS) as PreviewRole[]) {
    jwts[role] = await mintStorageState(role);
  }

  // Warm the freshly-deployed preview before the suite so the first real test
  // doesn't pay the full cold-SSR cost (Next warm-up + JIT + DB pools). Each route
  // JIT-compiles on its first hit, so we warm EVERY heavy SSR page the suite then
  // navigates — cold-page timeouts were the dominant smoke flake (a slow-window
  // page.goto exceeding the nav budget, then passing on retry once warm). They must
  // be warmed AUTHENTICATED: on a preview the gate 307s an UNauthenticated request
  // to /login, so an anon GET wouldn't touch the real render path. Sequential (one
  // concurrent heavy SSR at a time — the single-replica pod OOM'd under parallel
  // heavy loads) + non-fatal (.catch): a slow warm-up GET still triggers the
  // server-side compile even if the client times out, and the suite + retries
  // cover any miss.
  const gold = jwts.gold;
  if (gold) {
    const headers = { cookie: `${COOKIE_NAME}=${gold}` };
    // gold (gate-passing paid member) reaches all non-mod heavy pages the suite hits.
    for (const path of [
      '/',
      '/models',
      '/images',
      '/user/membership',
      '/generate',
      '/purchase/buzz',
      '/pricing',
    ]) {
      await request.get(path, { timeout: 60_000, headers }).catch(() => {});
    }
  }
  const mod = jwts.mod;
  if (mod) {
    // /moderator/* render only for a moderator (gold would be bounced), so warm the
    // moderation-spec pages with the mod cookie.
    const headers = { cookie: `${COOKIE_NAME}=${mod}` };
    for (const path of ['/moderator/reports', '/moderator/images']) {
      await request.get(path, { timeout: 60_000, headers }).catch(() => {});
    }
  }

  // Best-effort search warm-up (NOT a blocking readiness gate). The image-search
  // path (getAllImagesIndex -> the in-cluster feeds-proxy via METRICS_SEARCH_HOST)
  // can be cold/overloaded; fire ONE GET to warm the connection. We deliberately do
  // NOT poll-until-ready: the earlier 12x6s gate wasted up to ~72s when search was
  // overloaded for the whole window, and it was never the load-bearing fix anyway —
  // each search-dependent spec (whatIf, /moderator/images, image-feed) wraps its
  // query in retryFlaky (preview-retry.ts), which rides out a transient 408/5xx with
  // backoff. So a single fire-and-forget warm-up is all that's useful here.
  // (/moderator/images is already warmed by the mod loop above.)
  if (gold) {
    await request
      .get('/api/v1/images?sort=Most%20Reactions&limit=1', {
        timeout: 20_000,
        headers: { cookie: `${COOKIE_NAME}=${gold}` },
      })
      .catch(() => {});
  }
});
