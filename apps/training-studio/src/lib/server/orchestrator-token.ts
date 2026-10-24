import { env } from '$env/dynamic/private';
import { sql } from 'kysely';
import { pack } from 'msgpackr';
import { generateKey, generateSecretHash } from '@civitai/auth/secret-hash';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { db } from './db';
import { getSysRedis } from './redis';
import { hSetWithTTL, type EvalCapableClient } from './redis-atomic';

// The orchestrator authenticates callers with a user API key (it resolves the bearer against Civitai's
// /api/v1/me and caches it). We get-or-mint that key the same way the main app's getOrchestratorToken does:
//
//  1. Reuse the shared `generation:tokens` sys-redis hash — warmed by every generation/training call across
//     all pods, so it usually already holds a valid token for the user (one fewer mint). Stored raw (the
//     main app writes it via a Lua HSET), so we read it RAW (top-level hGet), never `.packed`.
//  2. Fall back to our OWN key (a token we minted before).
//  3. Mint a fresh `System` key — a fully valid token on its own, so a user who only ever uses THIS app
//     still works with no dependency on the main app warming the cache.
//
// We only ever WRITE our own key, never the shared hash — isolation, so a bug here can't affect the main
// app's token cache.
const SHARED_KEY = REDIS_SYS_KEYS.GENERATION.TOKENS;
const OWN_KEY = REDIS_SYS_KEYS.GENERATION.ORCHESTRATOR_TOKENS;
const GENERATION_TOKEN_NAME = 'generation-token';
const TTL_SECONDS = 3600;

/**
 * The orchestrator token for `userId` — the caller must already have authenticated this user (the spoke
 * guard resolves `locals.user` from the verified session before any handler runs, so the userId is trusted).
 */
export async function orchestratorToken(userId: number): Promise<string> {
  // Escape hatch: a pinned token (e.g. your own API key) to bypass mint+cache entirely.
  if (env.ORCHESTRATOR_MODE === 'dev' && env.ORCHESTRATOR_ACCESS_TOKEN)
    return env.ORCHESTRATOR_ACCESS_TOKEN;

  const field = String(userId);

  // 1. Shared cache — a token the main app / any pod already minted for this user. Raw. Fail-open.
  try {
    const shared = await getSysRedis().hGet<string>(SHARED_KEY, field);
    if (shared) return shared;
  } catch {
    // fall through
  }

  // 2. Our own cross-pod cache of a token WE minted (packed; safe — never touches the shared hash).
  try {
    const own = await getSysRedis().packed.hGet<string>(OWN_KEY, field);
    if (own) return own;
  } catch {
    // fall through
  }

  // 3. Mint. `expiresAt` is computed in the DB (`now() + interval`), NOT from a JS Date: `ApiKey.expiresAt`
  //    is `timestamp without time zone`, and node-postgres writes a JS Date's LOCAL wall-clock into it — so
  //    on a machine behind UTC the row lands already-expired, and `/api/v1/me` (which filters
  //    `expiresAt >= now()`) never finds the key → orchestrator 401. Computing it server-side is tz-proof.
  const token = generateKey();
  await db
    .insertInto('ApiKey')
    .values({
      key: generateSecretHash(token),
      name: GENERATION_TOKEN_NAME,
      userId,
      type: 'System',
      expiresAt: sql<Date>`now() + make_interval(secs => ${TTL_SECONDS + 5})`,
    })
    .execute();
  await db
    .deleteFrom('ApiKey')
    .where('userId', '=', userId)
    .where('name', '=', GENERATION_TOKEN_NAME)
    .where('type', '=', 'System')
    .where('expiresAt', '<', sql<Date>`now() + make_interval(secs => 30)`)
    .execute();

  // Cache in OUR key only (never the shared hash — a local mint must not overwrite a prod-valid token).
  try {
    await hSetWithTTL(
      getSysRedis() as unknown as EvalCapableClient,
      OWN_KEY,
      field,
      pack(token),
      TTL_SECONDS * 1000
    );
  } catch {
    // best-effort
  }

  return token;
}
