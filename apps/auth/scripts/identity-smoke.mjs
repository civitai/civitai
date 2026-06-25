// Identity-endpoint smoke test — runs the logical session flow against a LIVE dev hub, hitting the
// endpoints directly. Steps: dev-login → GET identity → refresh → invalidate → re-read.
//
// It only reads the user + writes the redis cache (no User-row mutations). Point the dev server's
// DATABASE_URL at a dev DB. dev-login is gated to `vite dev`, so this only works against a dev-mode server.
//
// Usage (from apps/auth, with the dev server running):
//   node scripts/identity-smoke.mjs
//   BASE_URL=http://localhost:5173 SMOKE_USER_ID=5 node scripts/identity-smoke.mjs
// AUTH_INTERNAL_TOKEN is read from the environment, or from apps/auth/.env as a fallback.
import { readFileSync } from 'node:fs';

const BASE = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
const USER_ID = Number(process.env.SMOKE_USER_ID ?? 5);

function internalToken() {
  if (process.env.AUTH_INTERNAL_TOKEN) return process.env.AUTH_INTERNAL_TOKEN;
  try {
    const txt = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = txt.match(/^AUTH_INTERNAL_TOKEN=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* no .env */
  }
  return undefined;
}

const TOKEN = internalToken();
if (!TOKEN) {
  console.error('✗ AUTH_INTERNAL_TOKEN not set (env or apps/auth/.env)');
  process.exit(1);
}

const svc = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    pass++;
  } else {
    console.error(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
    fail++;
  }
}
const post = (path, bodyObj) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: svc, body: JSON.stringify(bodyObj) });
const getAs = (userToken) =>
  fetch(`${BASE}/api/auth/identity`, { headers: { authorization: `Bearer ${userToken}` } });

async function main() {
  console.log(`identity smoke → ${BASE} (user ${USER_ID})\n`);

  // 1. dev sign-in → a session token for the user.
  const loginRes = await post('/api/auth/dev/login', { userId: USER_ID });
  const login = await loginRes.json().catch(() => ({}));
  check('dev-login mints a session token', loginRes.ok && typeof login.token === 'string', {
    status: loginRes.status,
    login,
  });
  const userToken = login.token;
  if (!userToken) return finish();

  // 2. GET identity with the user's token → the resolved user.
  const meRes = await getAs(userToken);
  const me = await meRes.json().catch(() => ({}));
  check('GET /identity returns the user', meRes.ok && me.id === USER_ID, { status: meRes.status, me });

  // 3. refresh (eager) → fresh user.
  const refRes = await post('/api/auth/identity', { userId: USER_ID, refresh: true });
  const ref = await refRes.json().catch(() => ({}));
  check('refresh returns the user', refRes.ok && ref.id === USER_ID, { status: refRes.status, ref });

  // 4. invalidate (lazy bust) → 204, then GET re-produces.
  const invRes = await post('/api/auth/identity', { userId: USER_ID });
  check('invalidate returns 204', invRes.status === 204, invRes.status);
  const me2Res = await getAs(userToken);
  const me2 = await me2Res.json().catch(() => ({}));
  check('GET /identity re-produces after invalidate', me2Res.ok && me2.id === USER_ID, {
    status: me2Res.status,
    me2,
  });

  finish();
}

function finish() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
