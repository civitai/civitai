// @ts-nocheck — plain Node ESM runtime script (run via `node`), not part of the app's TS project.
// Stub upstream OIDC provider for hub e2e — a deterministic stand-in for Discord/Google/etc.
// so the REAL hub callback path (apps/auth/src/routes/login/[provider]/callback) can run in CI
// without talking to a live provider.
//
// The hub's providers (apps/auth/src/lib/server/auth/providers.ts) are a generic abstraction
// with per-provider authorizeUrl/tokenUrl/userinfoUrl. Point ONE provider's three URLs at this
// server (via the hub deployment's env in the e2e environment) and a login through that provider
// exercises the genuine Authorization-Code + PKCE flow against fixed responses.
//
// Endpoints:
//   GET  /authorize  -> 302 back to `redirect_uri` with `?code=stub-code&state=<echoed>`
//   POST /token      -> { access_token, token_type, expires_in, scope }
//   GET  /userinfo   -> the fixed STUB_PROFILE (Bearer-gated)
//   GET  /healthz    -> 200 ok (readiness)
//
// Standalone (no deps — Node http only):
//   STUB_PORT=8771 node apps/auth/e2e/stub-oidc-server.mjs
//
// Self-test: see the `npm run` note in e2e/README.md, or the inline check at the bottom of this file
// (run with `--selftest`).
import http from 'node:http';

const PORT = Number(process.env.STUB_PORT ?? 8771);
const ACCESS_TOKEN = process.env.STUB_ACCESS_TOKEN ?? 'stub-access-token';
const STUB_PROFILE = {
  id: process.env.STUB_PROFILE_ID ?? 'stub-provider-user-1',
  email: process.env.STUB_PROFILE_EMAIL ?? 'ci-smoke-tester@civitai.test',
  email_verified: true,
  name: process.env.STUB_PROFILE_NAME ?? 'CI Smoke Tester',
  preferred_username: process.env.STUB_PROFILE_USERNAME ?? 'ci-smoke-tester',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export function createStubOidcServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: 'ok' });

    // Authorization endpoint — bounce straight back to the hub's callback with a fixed code,
    // echoing `state` (the hub checks it) and preserving the PKCE round-trip.
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state') ?? '';
      if (!redirectUri) return json(res, 400, { error: 'missing redirect_uri' });
      const back = new URL(redirectUri);
      back.searchParams.set('code', 'stub-code');
      if (state) back.searchParams.set('state', state);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    // Token endpoint — exchange the code for an access token (we don't validate the code/PKCE
    // verifier; this is a stub whose job is to keep the hub's real exchange code on its happy path).
    if (req.method === 'POST' && url.pathname === '/token') {
      return json(res, 200, {
        access_token: ACCESS_TOKEN,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'identify email',
      });
    }

    // Userinfo — Bearer-gated, returns the fixed profile the hub maps to a user.
    if (req.method === 'GET' && url.pathname === '/userinfo') {
      const auth = req.headers.authorization ?? '';
      if (!/^bearer /i.test(auth)) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, STUB_PROFILE);
    }

    return json(res, 404, { error: 'not_found' });
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain && !process.argv.includes('--selftest')) {
  createStubOidcServer().listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[stub-oidc] listening on http://localhost:${PORT}`);
  });
}

// `node stub-oidc-server.mjs --selftest` — drives the three endpoints and exits non-zero on mismatch.
if (isMain && process.argv.includes('--selftest')) {
  (async () => {
    const srv = createStubOidcServer();
    await new Promise((r) => srv.listen(PORT, () => r()));
    const base = `http://localhost:${PORT}`;
    let failed = 0;
    const check = (name, cond) => {
      // eslint-disable-next-line no-console
      console.log(`${cond ? '  ✓' : '  ✗'} ${name}`);
      if (!cond) failed++;
    };
    // /authorize -> 302 with code + echoed state
    const authRes = await fetch(
      `${base}/authorize?redirect_uri=${encodeURIComponent('https://hub.example/login/stub/callback')}&state=xyz`,
      { redirect: 'manual' }
    );
    const loc = authRes.headers.get('location') ?? '';
    check('/authorize 302', authRes.status === 302);
    check('/authorize returns code', loc.includes('code=stub-code'));
    check('/authorize echoes state', loc.includes('state=xyz'));
    // /token -> access_token
    const tokRes = await fetch(`${base}/token`, { method: 'POST' });
    const tok = await tokRes.json();
    check('/token 200', tokRes.status === 200);
    check('/token access_token', tok.access_token === ACCESS_TOKEN);
    // /userinfo -> 401 without bearer, profile with bearer
    const noAuth = await fetch(`${base}/userinfo`);
    check('/userinfo 401 without bearer', noAuth.status === 401);
    const uiRes = await fetch(`${base}/userinfo`, { headers: { authorization: `Bearer ${ACCESS_TOKEN}` } });
    const ui = await uiRes.json();
    check('/userinfo 200 with bearer', uiRes.status === 200);
    check('/userinfo returns profile', ui.email === STUB_PROFILE.email && ui.email_verified === true);
    await new Promise((r) => srv.close(() => r()));
    // eslint-disable-next-line no-console
    console.log(failed ? `\n${failed} check(s) FAILED` : '\nall stub-oidc checks passed');
    process.exit(failed ? 1 : 0);
  })();
}
