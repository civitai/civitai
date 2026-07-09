#!/usr/bin/env node
/**
 * Mint a gate-passing NextAuth session cookie for a deployed PR preview and
 * produce the runtime Lighthouse CI config that injects it.
 *
 * Why this exists: a deployed PR preview runs IS_PREVIEW=true and is gated by
 * preview-auth.middleware — an UNAUTHENTICATED request 302s to /login, so a
 * naive Lighthouse run would measure the login page, not the app. We mint the
 * same `__Secure-civitai-token` JWE the app signs with (next-auth/jwt encode +
 * the preview's shared NEXTAUTH_SECRET), as ci-smoke-gold (a paid member in the
 * flipt `preview-site-access` testers allowlist — id mirrors preview-fixtures /
 * the datapacket-talos seed-smoke-test-users CronJob), and put it in
 * collect.settings.extraHeaders.Cookie so headless Chrome clears the gate.
 *
 * This is the SAME mechanism tests/preview-auth.setup.ts uses for the smoke
 * suite; kept as a standalone .cjs so the Tekton lighthouse task can run it
 * with plain `node` (no ts/playwright) and NO external dependencies — the JWE
 * (dir/A256GCM), HKDF key derivation, and UUID all use Node's built-in
 * `node:crypto`, so it can't fail on an incomplete workspace install.
 *
 * Usage:
 *   NEXTAUTH_SECRET=... BASE_URL=https://pr-123.civitaic.com \
 *     node tests/lighthouse-mint-cookie.cjs
 * Writes lighthouserc.runtime.json (cwd) with extraHeaders + per-PR URLs.
 * Prints nothing sensitive (never the cookie value) to stdout.
 */
const fs = require('fs');
const path = require('path');
// Self-contained: the cookie JWE is built with Node's built-in node:crypto only
// (no jose / next-auth). This script runs in the constrained lhci-client image
// against the shared-workspace node_modules, which is occasionally an incomplete
// pnpm install — depending on ANY external package made the mint flaky
// ("Cannot find module 'jose'/'uuid'" -> Lighthouse silently skipped).
// node:crypto needs nothing installed, so the mint can no longer fail on deps.
const nodeCrypto = require('node:crypto');
const { hkdfSync, randomUUID, randomBytes, createCipheriv } = nodeCrypto;

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Compact-serialize a next-auth v4 session JWE: dir + A256GCM, with the AAD set
// to the ASCII base64url(protected header) per RFC 7516. Byte-for-byte the same
// shape jose's EncryptJWT produces (verified: jose.jwtDecrypt round-trips this
// output), so @civitai/auth's decodeLegacySessionCookie accepts it unchanged.
function encryptJWE(payload, key) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM' }), 'utf8'));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(header, 'ascii'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${header}..${b64url(iv)}.${b64url(ciphertext)}.${b64url(tag)}`;
}

const SECRET = process.env.NEXTAUTH_SECRET;
const BASE_URL = process.env.BASE_URL;
const COOKIE_NAME = '__Secure-civitai-token'; // libs/auth.ts — https => __Secure- prefix
const MAX_AGE_S = 30 * 24 * 60 * 60;

// Mint the legacy next-auth v4 session JWE WITHOUT next-auth (removed); the app still accepts it via
// @civitai/auth's decodeLegacySessionCookie. dir/A256GCM with an HKDF-derived key — mirrors that decoder.
const ENC_INFO = 'NextAuth.js Generated Encryption Key';
const derivedKey = (secret) => new Uint8Array(hkdfSync('sha256', secret, '', ENC_INFO, 32));

// Representative authed routes (kept small so 5 runs x N routes stays inside the
// build pool's time budget). All reachable by ci-smoke-gold. `/` = SSR home,
// `/models` = heavy list/feed, `/generate` = client-heavy generator, and
// `/models/4201` = a model DETAIL page (the highest-traffic entrypoint — search
// /social land here). 4201 (Realistic Vision V6.0, a foundational SD1.5 base
// model) is a deliberately stable pin: long-standing, SFW, present in prod AND
// the weekly cnpg-cluster-dev clone, so it resolves on either DB profile. The
// other 3 routes need no seeded entity; this one depends on 4201 existing — if
// it's ever unpublished, swap for another evergreen base model. Edit to change.
const ROUTES = ['/', '/models', '/generate', '/models/4201'];

// ci-smoke-gold — must mirror tests/preview-fixtures.ts PREVIEW_USERS.gold.
const GOLD = {
  id: 2000000004,
  username: 'ci-smoke-gold',
  email: 'ci-smoke-gold@civitai.test',
  isModerator: false,
  tier: 'gold',
  showNsfw: true,
  blurNsfw: false,
  browsingLevel: 1,
  onboarding: 15,
  muted: false,
};

async function main() {
  if (!SECRET) throw new Error('NEXTAUTH_SECRET is required to mint the preview cookie');
  if (!BASE_URL) throw new Error('BASE_URL is required (e.g. https://pr-123.civitaic.com)');

  const nowSec = Math.floor(Date.now() / 1000);
  const token = { user: GOLD, sub: String(GOLD.id), id: randomUUID(), signedAt: Date.now() };
  // JWT claims set, then encrypt as a JWE — mirrors next-auth v4 EncryptJWT
  // (.setIssuedAt()/.setExpirationTime()).
  const claims = { ...token, iat: nowSec, exp: nowSec + MAX_AGE_S };
  const value = encryptJWE(claims, derivedKey(SECRET));

  const base = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'lighthouserc.json'), 'utf8')
  );

  base.ci.collect.url = ROUTES.map((r) => `${BASE_URL.replace(/\/$/, '')}${r}`);
  base.ci.collect.settings = base.ci.collect.settings || {};
  // extraHeaders must be a JSON STRING per the LHCI schema.
  base.ci.collect.settings.extraHeaders = JSON.stringify({
    Cookie: `${COOKIE_NAME}=${value}`,
  });

  fs.writeFileSync('lighthouserc.runtime.json', JSON.stringify(base, null, 2));
  console.log(
    `Wrote lighthouserc.runtime.json — ${ROUTES.length} routes x ${base.ci.collect.numberOfRuns} runs, authed as ${GOLD.username}`
  );
  for (const u of base.ci.collect.url) console.log(`  - ${u}`);
}

main().catch((e) => {
  console.error(`mint-cookie failed: ${e.message}`);
  process.exit(1);
});
