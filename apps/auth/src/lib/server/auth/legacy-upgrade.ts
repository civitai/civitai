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
  type SessionUser,
} from '@civitai/auth';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { env } from '$env/dynamic/private';
import { evalSys } from '../redis';
import { cookieDomain } from './cookie';
import { setDeviceCookie } from './device';
import { clearLegacyCookies } from './legacy-cookies';
import { acceptHubSession, addDeviceFamily, markFamilyLive } from './lineage';
import { sessions } from './registry';
import { canHoldSession, getSigner, sessionExpiresIn, setSessionCookie } from './session';
import { getOrProduceSessionUser } from './session-producer';
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

// Off until every app reads the host-only slot first (rollout step 12 everywhere). Until then a shared-slot hub
// token is still the session other apps read, so host mode copies it but neither ends it nor expires its cookies.
const retireSharedSession = () =>
  /^(true|1|on|yes)$/i.test((env.AUTH_RETIRE_SHARED_SESSION ?? '').trim());

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

async function honouredSession(token: string): Promise<SessionClaims | null> {
  const claims = await verifier.verifyToken(token).catch(() => null);
  if (!claims || !Number.isFinite(Number(claims.sub))) return null;
  return (await acceptHubSession(claims)) ? claims : null;
}

/**
 * The shared-slot device id becomes the host-only one, so the browser keeps its account list. The shared one
 * wins when both exist: it is where a sign-in that moved the browser to a new id wrote it.
 */
function carryDeviceId(cookies: Cookies): string {
  const host = cookies.get(deviceCookieNameForSlot('host'));
  const id = cookies.get(deviceCookieNameForSlot('shared')) ?? host ?? randomUUID();
  if (host !== id) setDeviceCookie(cookies, id, 'host');
  return id;
}

async function recordFamily(cookies: Cookies, family: string | undefined): Promise<void> {
  await markFamilyLive(family);
  await addDeviceFamily(carryDeviceId(cookies), family, { proofFamily: family });
}

/**
 * At /authorize, give the hub a host-only copy of a session it read from the shared slot: same family and 90-day
 * clock, a new jti. The shared-slot token is left as it is. An impersonation session, or one whose account
 * may not hold a session, is never copied, and a host-only session that is already this one is kept.
 */
export async function preUpgradeHubSession(
  cookies: Cookies,
  shared: SessionClaims,
  user: SessionUser | undefined
): Promise<void> {
  if (!slotsDiffer() || shared.impersonatedBy != null || !canHoldSession(user)) return;
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
 * In host mode, move a browser that reaches the hub with a shared-slot token onto a host-only session; with
 * AUTH_RETIRE_SHARED_SESSION on, also end the shared-slot token and expire its cookies. Requests racing on the
 * same token all get the one session the first of them minted, for 60 seconds after that token is ended. A
 * host-only session the hub honours is kept, whoever it belongs to; the shared-slot token is ended only when it
 * is that same session. An impersonation session, or one whose
 * account may not hold a session, is not moved: it is served from the shared slot until it ends.
 * Returns the host-only token, or null when there is none to give.
 */
export async function upgradeHubSession(
  cookies: Cookies,
  sharedToken: string
): Promise<string | null> {
  if (!slotsDiffer()) return null;
  const hostToken = cookies.get(hostSessionCookieName());
  // Other hosts can write the shared slot, so it never displaces a host-only session.
  const host = hostToken ? await honouredSession(hostToken) : null;
  if (host) {
    if (!retireSharedSession()) return hostToken!;
    const shared = await signatureVerifier.verifyToken(sharedToken).catch(() => null);
    if (shared?.jti && shared.sub === host.sub && familyId(shared) === familyId(host)) {
      await sessions.invalidateToken(shared.jti, Number(shared.sub)).catch(() => undefined);
    }
    expireSharedSlot(cookies);
    return hostToken!;
  }
  const j0 = await signatureVerifier.verifyToken(sharedToken).catch(() => null);
  if (!j0?.jti || !Number.isFinite(Number(j0.sub))) return null;
  if (j0.impersonatedBy != null) return null;
  const user = await getOrProduceSessionUser(Number(j0.sub)).catch(() => null);
  if (!canHoldSession(user)) return null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const stored = await storedUpgrade(j0.jti);
    if (stored) return finish(cookies, j0, await sign(stored), { won: false });

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
  const retire = retireSharedSession();
  if (retire) await sessions.invalidateToken(j0.jti!, Number(j0.sub)).catch(() => undefined);
  // Only the minting request starts the 60s: a replay re-arming it would keep the ended token usable forever.
  if (won) {
    await evalSys(EXPIRE_SCRIPT, [resultKey(j0.jti!)], [String(UPGRADE_RESULT_TTL_S)]).catch(
      () => undefined
    );
  }
  if (retire) expireSharedSlot(cookies);
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
