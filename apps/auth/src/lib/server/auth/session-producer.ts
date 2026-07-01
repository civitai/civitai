import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '@civitai/redis';
import { env } from '$env/dynamic/private';
import type { SessionUser } from '@civitai/auth';
import { db } from '../db/db';
import { getRedis, getSysRedis } from '../redis';
import { shapeSessionUser } from './session-shape';

// The auth hub is the SOLE PRODUCER of session-user data (docs/thin-session-token-design.md, "LOCKED
// ARCHITECTURE"): query the user (+ profile picture + active subscriptions) + permissions, shape the rich
// SessionUser (the pure derivation lives in session-shape.ts), and write it to the SHARED cache
// (session:data2:{userId}) that every consumer reads. Consumers — including the main app — now only READ
// this cache (createSessionClient); the former main-app compute (src/server/auth/session-user.ts) is gone.

const SESSION_TTL = 4 * 60 * 60; // 4h — matches @civitai/auth's resolver TTL

export async function produceSessionUser(userId: number): Promise<SessionUser | null> {
  // 1. User + profile picture + active subscriptions (one shaped query — jsonArrayFrom folds the
  //    subscriptions, with their product metadata, into a single round-trip alongside the user).
  const row = await db
    .selectFrom('User')
    .where('User.id', '=', userId)
    .where('User.deletedAt', 'is', null)
    .select((eb) => [
      'User.id',
      'User.username',
      'User.name',
      'User.email',
      'User.emailVerified',
      'User.image',
      'User.createdAt',
      'User.isModerator',
      'User.showNsfw',
      'User.blurNsfw',
      'User.browsingLevel',
      'User.onboarding',
      'User.muted',
      'User.mutedAt',
      'User.bannedAt',
      'User.deletedAt',
      'User.customerId',
      'User.paddleCustomerId',
      'User.autoplayGifs',
      'User.leaderboardShowcase',
      'User.filePreferences',
      'User.settings',
      'User.meta',
      jsonObjectFrom(
        eb
          .selectFrom('Image')
          .select(['Image.url'])
          .whereRef('Image.id', '=', 'User.profilePictureId')
      ).as('profilePicture'),
      jsonObjectFrom(
        eb
          .selectFrom('UserReferral')
          .select(['UserReferral.id'])
          .whereRef('UserReferral.userId', '=', 'User.id')
      ).as('referral'),
      jsonArrayFrom(
        eb
          .selectFrom('CustomerSubscription')
          .whereRef('CustomerSubscription.userId', '=', 'User.id')
          .where('CustomerSubscription.status', 'not in', ['canceled', 'incomplete_expired'])
          .select((eb2) => [
            'CustomerSubscription.id',
            'CustomerSubscription.status',
            'CustomerSubscription.buzzType',
            jsonObjectFrom(
              eb2
                .selectFrom('Product')
                .select(['Product.metadata'])
                .whereRef('Product.id', '=', 'CustomerSubscription.productId')
            ).as('product'),
          ])
      ).as('subscriptionRows'),
      jsonArrayFrom(
        eb.selectFrom('UserRole').select(['UserRole.role']).whereRef('UserRole.userId', '=', 'User.id')
      ).as('roleRows'),
    ])
    .executeTakeFirst();

  if (!row) return null;

  // 2. permissions — system-permissions sysRedis cache. Degraded-skip: never cache a permissions-less
  //    user (would strip moderator/beta privileges until the entry expires); re-derive next request.
  const permissions: string[] = [];
  let permissionsDegraded = false;
  try {
    // Inside the try so a client-construction throw (bad URL/DNS) also routes to degraded, not a 500.
    const sysRedis = getSysRedis();
    if (!sysRedis) {
      permissionsDegraded = true; // no sysRedis configured — can't derive; don't cache empty perms
    } else {
      const raw = await sysRedis.get(REDIS_SYS_KEYS.SYSTEM.PERMISSIONS);
      if (raw) {
        const map = JSON.parse(raw) as Record<string, number[]>;
        for (const [permKey, ids] of Object.entries(map)) {
          if (Array.isArray(ids) && ids.includes(userId)) permissions.push(permKey);
        }
      }
    }
  } catch {
    permissionsDegraded = true;
  }

  // 3. Shape the SessionUser (pure derivation — see session-shape.ts).
  const sessionUser = shapeSessionUser({
    row,
    subscriptionRows: row.subscriptionRows,
    permissions,
    roles: row.roleRows.map((r) => r.role),
    tierKey: env.TIER_METADATA_KEY,
  });

  // 4. Write the shared cache (skip on degraded permissions — re-derive next request instead of
  //    persisting a privilege-stripped snapshot, mirroring the main app's permissionsSourceDegraded).
  if (!permissionsDegraded) {
    const redis = getRedis();
    if (redis) {
      try {
        await redis.packed.set(`${REDIS_KEYS.USER.SESSION}:${userId}`, sessionUser, {
          EX: SESSION_TTL,
        });
      } catch {
        // best-effort cache write — the endpoint still returns the produced user
      }
    }
  }

  return sessionUser;
}

// Read-through entry point for the /api/auth/identity endpoint: return the shared-cache entry when warm,
// produce fresh (DB → cache) only on a miss. This gives HTTP-only / isolated consumers the SAME caching a
// shared-redis consumer gets by reading the cache directly — without it, every isolated request would hit
// the DB. A forced refresh is "bust the key → next read re-produces", not a flag here.
export async function getOrProduceSessionUser(userId: number): Promise<SessionUser | null> {
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.packed.get<SessionUser>(`${REDIS_KEYS.USER.SESSION}:${userId}`);
      // `clearedAt` marks a tombstoned entry (mirrors the resolver) — treat as a miss.
      if (cached && typeof cached === 'object' && !('clearedAt' in cached)) return cached;
    } catch {
      // cache blip — fall through to produce fresh
    }
  }
  return produceSessionUser(userId);
}

// Bust a user's cached session (the write-side primitive behind `POST /api/auth/identity`). Deletes the
// shared key so the next read re-produces. Best-effort: a redis blip leaves the (stale) entry to expire by
// TTL rather than failing the caller.
export async function invalidateSessionUser(userId: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`${REDIS_KEYS.USER.SESSION}:${userId}`);
  } catch {
    // best-effort bust — falls back to TTL expiry
  }
}
