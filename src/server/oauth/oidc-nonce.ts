import { createHash } from 'crypto';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { AUTH_CODE_TTL } from '~/server/oauth/constants';

// OIDC `nonce` + `auth_time` capture for the id_token. @node-oauth/oauth2-server doesn't
// carry these through the code grant, so we stash them in Redis keyed by a hash of the
// authorization code at /authorize and consume them at /token. Same TTL as the auth code.
//
// Mirrors the authorization-code storage in model.ts: a packed hash with the sha256(code)
// as the field, so raw codes never sit in Redis.

type OidcCodeContext = { nonce?: string; authTime?: number };

const field = (code: string) => createHash('sha256').update(code).digest('hex');

export async function storeOidcContext(code: string, ctx: OidcCodeContext): Promise<void> {
  if (!ctx.nonce && !ctx.authTime) return;
  try {
    const f = field(code);
    await redis.packed.hSet(REDIS_KEYS.OAUTH.OIDC_CONTEXT, f, ctx);
    await redis.hExpire(REDIS_KEYS.OAUTH.OIDC_CONTEXT, f, AUTH_CODE_TTL);
  } catch {
    // Best-effort: a miss just means the id_token omits nonce — acceptable degradation over
    // failing the whole token exchange.
  }
}

/** Single-use: reads and deletes the context for a code. */
export async function consumeOidcContext(code: string): Promise<OidcCodeContext> {
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
