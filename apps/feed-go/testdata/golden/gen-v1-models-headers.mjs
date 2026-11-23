// Writes the response-header cases in v1-models-headers/ (GET /api/v1/models and /api/v1/models/[id]).
//
//   GOLDEN_NODE_MODULES=<clone>/node_modules node apps/feed-go/testdata/golden/gen-v1-models-headers.mjs
//
// Each case names a body fixture of v1-models/ (its request and world), adds request headers, and
// states the headers Node's route sets on its 200: the endpoint wrapper (MixedAuthEndpoint /
// PublicEndpoint, and withBlockScope on [id]), the handler, and res.json's ETag. The header VALUES are
// written here by hand; src/server/__tests__/feed-go-v1-models.golden.test.ts runs the REAL wrappers
// and handlers over each case and requires exactly these headers (on a mismatch it prints them). The
// ETag is not hand-written: it is Next's own generateETag over the body fixture's expect.body (the
// string res.json sends), so re-run this after a body fixture changes.
// apps/feed-go/internal/v1models/headers_golden_test.go requires the same headers from Go.
//
// next.config's headers() (X-Frame-Options) are set by the router, not the route, so they are not in
// these cases: configheaders.json holds them, pinned by feed-go-v1-models-config-headers.test.ts.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Next must resolve from the repo's node_modules, or GOLDEN_NODE_MODULES (a worktree without one).
const require = createRequire(import.meta.url);
const paths = process.env.GOLDEN_NODE_MODULES ? [process.env.GOLDEN_NODE_MODULES] : undefined;
const { generateETag } = require(require.resolve('next/dist/server/lib/etag', { paths }));

const HERE = dirname(fileURLToPath(import.meta.url));
const BODIES = join(HERE, 'v1-models');
const OUT = join(HERE, 'v1-models-headers');

const PUBLIC_CC = 'public, s-maxage=300, stale-while-revalidate=150';
const PRIVATE_CC = 'max-age=0, private, no-cache';
const NO_STORE = 'private, no-store';
// addCorsHeaders without allowCredentials, and the Vary for a request with no credential.
const BASE = {
  vary: 'Authorization',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type, *',
  'access-control-allow-methods': 'GET',
};

const cases = [
  {
    name: 'list-anonymous',
    fixture: 'list-defaults-lookahead.json',
    headers: {},
    expect: { ...BASE, 'cache-control': PUBLIC_CC },
  },
  {
    // MixedAuthEndpoint's CORS is `*` whatever the Origin (no block scope on the list).
    name: 'list-anonymous-any-origin',
    fixture: 'list-defaults-lookahead.json',
    headers: { origin: 'https://elsewhere.example.test' },
    expect: { ...BASE, 'cache-control': PUBLIC_CC },
  },
  {
    name: 'list-paging',
    fixture: 'list-username-paging-primary-only.json',
    headers: {},
    expect: { ...BASE, 'cache-control': PUBLIC_CC },
  },
  {
    // The handler's own no-store for `nsfw` overrides the wrapper's public policy.
    name: 'list-nsfw',
    fixture: 'list-newest-nsfw-date-cursor.json',
    headers: {},
    expect: { ...BASE, 'cache-control': NO_STORE },
  },
  {
    // A verified crawler (the header the API policy decided; feed-go reads it on a shadow sample).
    name: 'list-verified-crawler',
    fixture: 'list-defaults-lookahead.json',
    headers: { 'x-civitai-verified-bot': 'googlebot' },
    expect: { ...BASE, 'cache-control': PRIVATE_CC },
  },
  {
    name: 'detail-anonymous',
    fixture: 'detail-all-levels.json',
    headers: {},
    expect: { ...BASE, 'cache-control': NO_STORE },
  },
  {
    // [id] reads no session: a session cookie changes only the Vary.
    name: 'detail-session-cookie',
    fixture: 'detail-all-levels.json',
    headers: { cookie: 'theme=dark; __Secure-civ-token=t' },
    expect: { ...BASE, vary: 'Authorization, Cookie', 'cache-control': NO_STORE },
  },
  {
    // requestCarriesCallerCredentials counts the legacy next-auth cookie too.
    name: 'detail-legacy-session-cookie',
    fixture: 'detail-all-levels.json',
    headers: { cookie: '__Secure-civitai-token=t' },
    expect: { ...BASE, vary: 'Authorization, Cookie', 'cache-control': NO_STORE },
  },
  {
    name: 'detail-origin-cache-hit',
    fixture: 'detail-origin-cache-hit.json',
    headers: {},
    expect: { ...BASE, 'cache-control': NO_STORE },
  },
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const bodies = new Set(readdirSync(BODIES));
for (const c of cases) {
  if (!bodies.has(c.fixture)) throw new Error(`${c.name}: no body fixture ${c.fixture}`);
  const fx = JSON.parse(readFileSync(join(BODIES, c.fixture), 'utf8'));
  if (fx.expect?.fallback || typeof fx.expect?.body !== 'string') {
    throw new Error(`${c.name}: ${c.fixture} has no expected body`);
  }
  const doc = {
    name: c.name,
    fixture: c.fixture,
    request: { headers: c.headers },
    expect: { headers: { ...c.expect, etag: generateETag(fx.expect.body) } },
  };
  writeFileSync(join(OUT, `${c.name}.json`), JSON.stringify(doc, null, 2) + '\n');
}
console.log(`wrote ${cases.length} cases to ${OUT}`);
