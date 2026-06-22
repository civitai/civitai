import { createHash } from 'crypto';
import { pack } from 'msgpackr';
import { REDIS_KEYS } from '@civitai/redis';
import { getRedis } from '$lib/server/redis';
import { AUTH_CODE_TTL } from './constants';
import { hSetWithTTL, type EvalCapableClient } from './redis-atomic';

// OIDC `nonce` + `auth_time` capture for the id_token. @node-oauth/oauth2-server doesn't carry these
// through the code grant, so we stash them in Redis keyed by a hash of the authorization code at
// /authorize and consume them at /token. Same TTL as the auth code.
//
// Ported from the main app's src/server/oauth/oidc-nonce.ts; the only change is sourcing redis from the
// hub's getRedis() (null when REDIS_URL is unset → best-effort degrade, the id_token just omits nonce).
// Mirrors the authorization-code storage in model.ts: a packed hash with sha256(code) as the field, so
// raw codes never sit in Redis.

type OidcCodeContext = { nonce?: string; authTime?: number };

const field = (code: string) => createHash('sha256').update(code).digest('hex');

export async function storeOidcContext(code: string, ctx: OidcCodeContext): Promise<void> {
  if (!ctx.nonce && !ctx.authTime) return;
  const redis = getRedis();
  if (!redis) return;
  try {
    const f = field(code);
    // Atomic HSET+HPEXPIRE (one EVAL) — same hardening as the auth-code store (model.ts). A sequential
    // hSet + hExpire could leave a no-TTL nonce field if the process dies between awaits. `redis.packed.hGet`
    // in consumeOidcContext unpacks the msgpackr bytes written here, exactly as the auth-code path does.
    await hSetWithTTL(
      redis as unknown as EvalCapableClient,
      REDIS_KEYS.OAUTH.OIDC_CONTEXT,
      f,
      pack(ctx),
      AUTH_CODE_TTL * 1000
    );
  } catch {
    // Best-effort: a miss just means the id_token omits nonce — acceptable degradation over failing the
    // whole token exchange.
  }
}

/** Single-use: reads and deletes the context for a code. */
export async function consumeOidcContext(code: string): Promise<OidcCodeContext> {
  const redis = getRedis();
  if (!redis) return {};
  try {
    const f = field(code);
    const data = await redis.packed.hGet<OidcCodeContext>(REDIS_KEYS.OAUTH.OIDC_CONTEXT, f);
    if (!data) return {};
    await redis.hDel(REDIS_KEYS.OAUTH.OIDC_CONTEXT, f);
    return data;
  } catch {
    return {};
  }
}
