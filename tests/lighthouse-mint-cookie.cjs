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
 * with plain `node` (no ts/playwright) using the next-auth/jwt + uuid already
 * installed into the shared workspace node_modules by the typecheck task.
 *
 * Usage:
 *   NEXTAUTH_SECRET=... BASE_URL=https://pr-123.civitaic.com \
 *     node tests/lighthouse-mint-cookie.cjs
 * Writes lighthouserc.runtime.json (cwd) with extraHeaders + per-PR URLs.
 * Prints nothing sensitive (never the cookie value) to stdout.
 */
const fs = require('fs');
const path = require('path');
const { encode } = require('next-auth/jwt');
const { v4: uuid } = require('uuid');

const SECRET = process.env.NEXTAUTH_SECRET;
const BASE_URL = process.env.BASE_URL;
const COOKIE_NAME = '__Secure-civitai-token'; // libs/auth.ts — https => __Secure- prefix
const MAX_AGE_S = 30 * 24 * 60 * 60;

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

  const token = { user: GOLD, sub: String(GOLD.id), id: uuid(), signedAt: Date.now() };
  const value = await encode({ token, secret: SECRET, maxAge: MAX_AGE_S });

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
