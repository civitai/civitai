import { createHash, randomUUID } from 'crypto';
import type { Cookies } from '@sveltejs/kit';
import {
  deviceCookieNameForSlot,
  familyClaims,
  familyId,
  hostSessionCookieName,
  sessionCookieName,
  sessionCookieNameForSlot,
  legacySessionCookieName,
  type SessionClaims,
} from '@civitai/auth';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { evalSys } from '../redis';
import { cookieDomain } from './cookie';
import { setDeviceCookie } from './device';
import { clearLegacyCookies } from './legacy-cookies';
import { acceptHubSession, addDeviceFamily, markFamilyLive } from './lineage';
import { sessions } from './registry';
import { getSigner, sessionExpiresIn, setSessionCookie } from './session';
import { signatureVerifier, verifier } from './verifier';

// The hub moves its own session from the shared slot (Domain=<registrable>) to its host-only slot. Before the hub
// reads the host-only slot first, /authorize copies the shared session into it (preUpgradeHubSession). Once it
// does, a browser still carrying only a shared-slot token is moved over on its next hub request
// (upgradeHubSession), and that token is ended so it can't be replayed.

const UPGRADE_RESULT_TTL_S = 60;
const UPGRADE_LOCK_TTL_S = 5;
const LOSER_POLL_MS = 500;
const POLL_STEP_MS = 50;
// Bounds a request behind a winner that died holding the lock: about one lock lifetime of retries.
const MAX_ATTEMPTS = 12;

// A type alias, not an interface: the signer takes an index-signature record.
type UpgradeClaims = { sub: string; signedAt: number; iat0?: number; sid?: string };
interface Upgrade {
  jti: string;
  claims: UpgradeClaims;
}

const digest = (jti: string) => createHash('sha256').update(jti).digest('base64url');
const resultKey = (jti: string) => `${REDIS_SYS_KEYS.SESSION.HUB_UPGRADE}:${digest(jti)}`;
const lockKey = (jti: string) => `${REDIS_SYS_KEYS.SESSION.HUB_UPGRADE_LOCK}:${digest(jti)}`;

/** In dev both slots share one name, so there is nothing to move. */
const slotsDiffer = () => hostSessionCookieName() !== sessionCookieName();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function newUpgrade(from: SessionClaims): Upgrade {
  const now = Date.now();
  const { iat0, sid } = familyClaims(from, { clearImpersonation: true, now });
  return {
    jti: randomUUID(),
    claims: { sub: String(from.sub), signedAt: now, iat0, ...(sid ? { sid } : {}) },
  };
}

const sign = ({ jti, claims }: Upgrade) =>
  getSigner().mintSessionToken(claims, { jti, expiresIn: sessionExpiresIn(claims) });

/** Whether `token` is a live session of the same family and account as `of`. */
async function isSameSession(token: string | undefined, of: SessionClaims): Promise<boolean> {
  if (!token) return false;
  const claims = await verifier.verifyToken(token).catch(() => null);
  return !!claims && claims.sub === of.sub && familyId(claims) === familyId(of);
}

/** The shared-slot device id becomes the host-only one, so the browser keeps its account list. */
function carryDeviceId(cookies: Cookies): string {
  const host = cookies.get(deviceCookieNameForSlot('host'));
  if (host) return host;
  const id = cookies.get(deviceCookieNameForSlot('shared')) ?? randomUUID();
  setDeviceCookie(cookies, id, 'host');
  return id;
}

async function recordFamily(cookies: Cookies, family: string | undefined): Promise<void> {
  await markFamilyLive(family);
  await addDeviceFamily(carryDeviceId(cookies), family, { proofFamily: family });
}

/**
 * At /authorize, give the hub a host-only copy of a session it read from the shared slot: same family and 90-day
 * clock, a new jti. The shared-slot token is left as it is. An impersonation session is never copied, and a
 * host-only session that is already this one is kept.
 */
export async function preUpgradeHubSession(cookies: Cookies, shared: SessionClaims): Promise<void> {
  if (!slotsDiffer() || shared.impersonatedBy != null) return;
  if (await isSameSession(cookies.get(hostSessionCookieName()), shared)) return;
  const upgrade = newUpgrade(shared);
  const token = await sign(upgrade);
  await sessions.trackToken(upgrade.jti, Number(upgrade.claims.sub)).catch(() => undefined);
  await recordFamily(cookies, familyId({ ...upgrade.claims, jti: upgrade.jti }));
  setSessionCookie(cookies, token, 'host');
}

const GET_SCRIPT = `return redis.call('GET', KEYS[1])`;
const LOCK_SCRIPT = `
  if redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 1 end
  return 0
`;
const STORE_SCRIPT = `redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]) return 1`;
const EXPIRE_SCRIPT = `return redis.call('EXPIRE', KEYS[1], ARGV[1])`;

async function storedUpgrade(jti: string): Promise<Upgrade | null> {
  const raw = await evalSys(GET_SCRIPT, [resultKey(jti)], []).catch(() => null);
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as Upgrade;
  } catch {
    return null;
  }
}

/** True when this request holds the mint, or no redis can say otherwise. */
async function takeLock(jti: string): Promise<boolean> {
  try {
    const won = await evalSys(LOCK_SCRIPT, [lockKey(jti)], [String(UPGRADE_LOCK_TTL_S)]);
    return won === null || Number(won) === 1;
  } catch {
    return true;
  }
}

async function awaitWinner(jti: string): Promise<Upgrade | null> {
  for (let waited = 0; waited < LOSER_POLL_MS; waited += POLL_STEP_MS) {
    await sleep(POLL_STEP_MS);
    const stored = await storedUpgrade(jti);
    if (stored) return stored;
  }
  return null;
}

/**
 * In host mode, move a browser that reaches the hub with a shared-slot token onto a host-only session and end
 * the shared-slot token. Requests racing on the same token all get the one session the first of them minted,
 * for 60 seconds after that token is ended. Returns the host-only token, or null when the shared-slot token is
 * not a session the hub honours.
 */
export async function upgradeHubSession(
  cookies: Cookies,
  sharedToken: string
): Promise<string | null> {
  if (!slotsDiffer()) return null;
  const j0 = await signatureVerifier.verifyToken(sharedToken).catch(() => null);
  if (!j0?.jti || !Number.isFinite(Number(j0.sub))) return null;
  const hostToken = cookies.get(hostSessionCookieName());

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const stored = await storedUpgrade(j0.jti);
    if (stored) return finish(cookies, j0, await sign(stored), { won: false });
    if (await isSameSession(hostToken, j0)) return finish(cookies, j0, hostToken!, { won: false });

    const live = await verifier.verifyToken(sharedToken).catch(() => null);
    if (!live || !(await acceptHubSession(live))) return null;

    if (!(await takeLock(j0.jti))) {
      const winner = await awaitWinner(j0.jti);
      if (winner) return finish(cookies, j0, await sign(winner), { won: false });
      continue;
    }
    const upgrade = newUpgrade(j0);
    await sessions.trackToken(upgrade.jti, Number(upgrade.claims.sub)).catch(() => undefined);
    await evalSys(
      STORE_SCRIPT,
      [resultKey(j0.jti)],
      [JSON.stringify(upgrade), String(UPGRADE_RESULT_TTL_S)]
    ).catch(() => undefined);
    return finish(cookies, j0, await sign(upgrade), { won: true });
  }
  return null;
}

async function finish(
  cookies: Cookies,
  j0: SessionClaims,
  token: string,
  { won }: { won: boolean }
): Promise<string> {
  if (cookies.get(hostSessionCookieName()) !== token) setSessionCookie(cookies, token, 'host');
  await recordFamily(cookies, familyId(j0));
  await sessions.invalidateToken(j0.jti!, Number(j0.sub)).catch(() => undefined);
  // Only the minting request starts the 60s: a replay re-arming it would keep the ended token usable forever.
  if (won) {
    await evalSys(EXPIRE_SCRIPT, [resultKey(j0.jti!)], [String(UPGRADE_RESULT_TTL_S)]).catch(
      () => undefined
    );
  }
  expireSharedSlot(cookies);
  return token;
}

/** Expire the shared-slot session and device cookies, and any next-auth ones, where present. */
function expireSharedSlot(cookies: Cookies): void {
  const domain = cookieDomain();
  for (const name of [sessionCookieNameForSlot('shared'), deviceCookieNameForSlot('shared')]) {
    if (cookies.get(name) === undefined) continue;
    cookies.delete(name, { path: '/', secure: true });
    if (domain) cookies.delete(name, { path: '/', secure: true, domain });
  }
  if (cookies.get(legacySessionCookieName()) !== undefined) clearLegacyCookies(cookies);
}
