import { createHash } from 'crypto';
import { pack } from 'msgpackr';
import { REDIS_KEYS } from '@civitai/redis';
import { getRedis } from '$lib/server/redis';
import { AUTH_CODE_TTL } from './constants';
import { hSetWithTTL, type EvalCapableClient } from './redis-atomic';

// OIDC `nonce` + `auth_time` capture for the id_token. @node-oauth/oauth2-server doesn't carry these
// through the code grant, so we stash them in Redis keyed by a hash of the authorization code at
// /authorize and read them at /token and /session. Same TTL as the auth code.
//
// Ported from the main app's src/server/oauth/oidc-nonce.ts; the only change is sourcing redis from the
// hub's getRedis() (null when REDIS_URL is unset → best-effort degrade, the id_token just omits nonce).
// Mirrors the authorization-code storage in model.ts: a packed hash with sha256(code) as the field, so
// raw codes never sit in Redis.

// `deviceId` rides the SAME code-keyed context (same TTL; /session removes it once a session is minted) for the FIRST-PARTY bridge: /authorize
// (a browser nav that CAN read the hub's shared `.civitai.com` civ-device) stashes the family device id here,
// and /session (a server-to-server call that CANNOT see that cookie) reads it back to register the account +
// hand the SAME id to the spoke — so every domain shares one device set. First-party codes carry only
// `deviceId` (no OIDC nonce); third-party OIDC codes carry nonce/authTime — the two flows never overlap.
// `openid` records a request that asked for the `openid` scope, which earns an id_token with or without a nonce.
// `family`, `iat0`, `impersonatedBy` and `impExp` are the hub session's lineage, for a code minted for the hub
// session's own user. `proofFamily` is the hub session's family whoever the code is for: it lets /session record
// a new family against this browser.
type OidcCodeContext = {
  nonce?: string;
  openid?: boolean;
  authTime?: number;
  deviceId?: string;
  family?: string;
  iat0?: number;
  impersonatedBy?: number;
  impExp?: number;
  proofFamily?: string;
};

const field = (code: string) => createHash('sha256').update(code).digest('hex');

/** Whether the context was stored; nothing to store counts as stored. */
export async function storeOidcContext(code: string, ctx: OidcCodeContext): Promise<boolean> {
  if (!ctx.nonce && !ctx.authTime && !ctx.deviceId) return true;
  const redis = getRedis();
  if (!redis) return false;
  try {
    const f = field(code);
    // Atomic HSET+HPEXPIRE (one EVAL) — same hardening as the auth-code store (model.ts). A sequential
    // hSet + hExpire could leave a no-TTL nonce field if the process dies between awaits. `redis.packed.hGet`
    // in readOidcContext / consumeOidcContext unpacks the msgpackr bytes written here, exactly as the auth-code path does.
    await hSetWithTTL(
      redis as unknown as EvalCapableClient,
      REDIS_KEYS.OAUTH.OIDC_CONTEXT,
      f,
      pack(ctx),
      AUTH_CODE_TTL * 1000
    );
    return true;
  } catch {
    // Best-effort: a miss means the id_token omits nonce, or for an openid-only request isn't issued.
    // The caller refuses an impersonation hand-off whose context was not stored.
    return false;
  }
}

/** The context for a code, left in place. `null` when it is missing or could not be read. */
export async function readOidcContext(code: string): Promise<OidcCodeContext | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return (
      (await redis.packed.hGet<OidcCodeContext>(REDIS_KEYS.OAUTH.OIDC_CONTEXT, field(code))) ?? null
    );
  } catch {
    return null;
  }
}

/** Best-effort removal of a code's context once the code itself is consumed. */
export async function deleteOidcContext(code: string): Promise<void> {
  await getRedis()
    ?.hDel(REDIS_KEYS.OAUTH.OIDC_CONTEXT, field(code))
    .catch(() => undefined);
}

/** Single-use: reads and deletes the context for a code. `null` when it is missing or could not be read. */
export async function consumeOidcContext(code: string): Promise<OidcCodeContext | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const f = field(code);
    const data = await redis.packed.hGet<OidcCodeContext>(REDIS_KEYS.OAUTH.OIDC_CONTEXT, f);
    if (!data) return null;
    await redis.hDel(REDIS_KEYS.OAUTH.OIDC_CONTEXT, f);
    return data;
  } catch {
    return null;
  }
}
