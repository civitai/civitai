import { purgeCache } from '~/server/cloudflare/client';
import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  readUserCreatorViaKysely,
  readUserCreatorViaPrisma,
  type UserCreatorWhere,
} from '~/server/services/user-creator.reads';
import { createCachedObject } from '~/server/utils/cache-helpers';

/**
 * The creator card read behind `user.getCreator`, uncached. `getUserCreator` in user.service is the
 * entry point; it serves an id-only lookup from `userCreatorCache` below and passes every other shape
 * (a username, or both) straight here.
 */
export async function fetchUserCreator(where: UserCreatorWhere) {
  // `kysely-hot-reads-2` on: the same two reads in one Kysely statement, on the replica as before.
  const found = (await isFlipt(FLIPT_FEATURE_FLAGS.KYSELY_HOT_READS_2))
    ? await readUserCreatorViaKysely((await loadKyselyDb()).kyselyRead, where)
    : await readUserCreatorViaPrisma(dbRead, where);
  if (!found) return null;
  const { user, modelCount } = found;

  // Expose only whether the shop is public — never leak the raw settings blob.
  const { settings, ...rest } = user;
  const creatorShopEnabled =
    (settings as { creatorShop?: { enabled?: boolean } } | null)?.creatorShop?.enabled === true;
  return {
    ...rest,
    creatorShopEnabled,
    _count: { models: modelCount },
  };
}

export type CachedUserCreator = NonNullable<Awaited<ReturnType<typeof fetchUserCreator>>>;

export const USER_CREATOR_CACHE_TTL = CacheTTL.xs;

/**
 * Seconds a bust holds the entry uncached (see WHAT INVALIDATES IT below). Reads in it hit the replica
 * uncached, so it must stay well above typical replica lag, and each second costs every read of a
 * busted user a database lookup. Equal to the builder's non-SWR default today; pinned here because
 * this card is read on most signed-in pages and busted on every session invalidation, so a change to
 * that default should not move it silently.
 */
export const USER_CREATOR_BUST_WINDOW_S = 2;

/**
 * The creator card by user id — the shape the creator card, the header and most other callers ask
 * for, and one of the most frequent lookups on the web tier. Both queries above (the user and the
 * published-model count) are cached together, as one entry per user.
 *
 * WHAT INVALIDATES IT. `bustUserCreatorCache` replaces the entry with the builder's bust marker, which
 * lives `USER_CREATOR_BUST_WINDOW_S`. While it stands every read goes to the database (the replica)
 * and nothing is written back, so a read landing inside replication lag is served but not re-cached;
 * the first read after the marker expires refills the entry. The window only covers lag shorter than
 * itself. The builder's refill is also an unconditional SET, so a miss that began before the bust (on
 * any pod) can overwrite the marker with the pre-write card, for at most a TTL. It is called from:
 *   - `bustUserCreator`, which every write that already purged the `user-creator-<id>` edge tag now
 *     goes through: profile and user updates, links, showcase, milestone cosmetic grants. The Redis
 *     bust lands BEFORE the edge purge; the other order would let the edge refill from the stale
 *     entry and keep it for its own TTL.
 *   - `clearSessionCache`, i.e. every server-side `refreshSession` / `invalidateSession` (session
 *     invalidation events, not a user's routine session reads): ban, mute, strikes, account deletion,
 *     membership and subscription changes, profile saves.
 *   - `deleteUserCosmeticCache`, i.e. equipping and unequipping a cosmetic.
 *
 * WHAT IS LEFT TO THE TTL (≤ 60 s, on top of the edge cache's own TTL, which already applied to all of
 * these before this cache existed): stats and rank (written by jobs), the published-model count,
 * cosmetics granted or removed by event and shop paths that do not refresh the session, and
 * `excludeFromLeaderboards` (moderator-only, masked for everyone else by the handler).
 *
 * Deliberately NOT here:
 *   - negative results (`cacheNotFound: false`): a user who does not exist yet, or a deleted one being
 *     restored, is never pinned as missing;
 *   - stale-while-revalidate: with it, a bust only marks the entry stale and the next readers are
 *     still served the old card, which would re-seed the edge cache right after a purge;
 *   - an in-process L1: a per-pod copy cannot see a cross-pod bust.
 *
 * With no L1, every fetch decodes a fresh object, so the handler masking a field on its result
 * cannot reach another caller.
 */
function createUserCreatorCache() {
  return createCachedObject<CachedUserCreator>({
    key: REDIS_KEYS.CACHES.USER_CREATOR,
    idKey: 'id',
    ttl: USER_CREATOR_CACHE_TTL,
    debounceTime: USER_CREATOR_BUST_WINDOW_S,
    staleWhileRevalidate: false,
    cacheNotFound: false,
    lookupFn: async (ids) => {
      const rows = await Promise.all(ids.map((id) => fetchUserCreator({ id })));
      return Object.fromEntries(
        rows.filter((row): row is CachedUserCreator => !!row).map((row) => [row.id, row])
      );
    },
  });
}

let instance: ReturnType<typeof createUserCreatorCache> | undefined;
export function userCreatorCache() {
  return (instance ??= createUserCreatorCache());
}

export async function getCachedUserCreator(id: number) {
  const results = await userCreatorCache().fetch(id);
  return results[id] ?? null;
}

/**
 * Drop the cached creator card of these users. Never throws: it runs after the write it follows has
 * committed, and a failure only leaves the entry to expire on its TTL.
 */
export async function bustUserCreatorCache(userIds: number | number[]) {
  const ids = [...new Set([userIds].flat())];
  if (!ids.length) return;
  try {
    await userCreatorCache().bust(ids);
  } catch (error) {
    logToAxiom(
      {
        type: 'error',
        name: 'user-creator-cache-bust-failed',
        ids: ids.join(','),
        error: error instanceof Error ? error.message : String(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
  }
}

/** The edge-cache tag `user.getCreator` responses carry, by user id or by username. */
export const userCreatorEdgeTag = (idOrUsername: number | string) => `user-creator-${idOrUsername}`;

/**
 * Drop both copies of these users' creator card: the Redis entry first, then the edge cache. Never
 * throws.
 *
 * Responses are tagged by id and by username, so the purge covers both: the current username is read
 * from the primary (call this after the write commits, so a rename purges the new name too), plus any
 * `usernames` the caller passes, e.g. the name before a rename. If that read fails the id tags are
 * still purged.
 *
 * The Redis bust is always awaited. The edge purge is dispatched without being awaited, which is
 * right for a single user's write. A BULK caller looping over chunks must pass `awaitPurge: true`:
 * `purgeCache` reads one Redis set per tag and paces its dispatch to the CDN's rate limit, and that
 * pacing only holds across chunks if each chunk's purge finishes before the next starts.
 */
export async function bustUserCreator(
  userIds: number | number[],
  { awaitPurge = false, usernames = [] }: { awaitPurge?: boolean; usernames?: string[] } = {}
) {
  const ids = [...new Set([userIds].flat())];
  if (!ids.length) return;
  await bustUserCreatorCache(ids);
  const purge = dbWrite.user
    .findMany({ where: { id: { in: ids } }, select: { username: true } })
    .then((rows) => rows.flatMap((row) => (row.username ? [row.username] : [])))
    .catch(() => [] as string[])
    .then((current) =>
      purgeCache({ tags: [...ids, ...current, ...usernames].map(userCreatorEdgeTag) })
    )
    .catch(() => undefined);
  if (awaitPurge) await purge;
}
