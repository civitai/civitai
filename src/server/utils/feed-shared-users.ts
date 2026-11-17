import { FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';
import { createCachedFlagGate } from '~/server/utils/otel-withspan-gate';

/**
 * One `user` object per creator in a feed response (`image.getInfinite`,
 * `image.getImagesAsPostsInfinite`), behind the `image-feed-shared-users` Flipt flag.
 *
 * Every feed image carries its creator as `user` ({ id, username, image, deletedAt, cosmetics,
 * profilePicture }), built fresh per image, so a creator with N images on a page is written N
 * times. The response serializers both key on object IDENTITY:
 *  - devalue writes an object it has already written as a back-reference (an index), so one
 *    shared `user` is written once per response instead of once per image;
 *  - superjson walks an object it has already walked once, and the fast superjson walk can reuse
 *    it too (`trpc-fast-superjson-shared-refs`).
 *
 * The wire shape the client decodes is unchanged: both decoders rebuild the same values (devalue
 * and superjson's `referentialEqualities` both restore the sharing), so a client of any version
 * reads the same fields whichever way the server wrote them — which is what a mixed fleet during
 * a deploy needs. Nothing is removed or renamed.
 *
 * A `user` is replaced only by an EQUAL one: the same keys, each value identical, a Date with the
 * same time, or both empty arrays. Two images of one creator from one fetch always match (their
 * `user` is built from the same per-creator lookups); a `user` that differs in anything (another
 * fetch's cosmetics, say) is left as it is. The input is never mutated: a changed item is a
 * shallow copy.
 */

type WithUser = { user?: unknown };

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return Array.isArray(a) && Array.isArray(b) && a.length === 0 && b.length === 0;
}

/** Whether two `user` objects are interchangeable on the wire (see the module doc). */
export function isSameFeedUser(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const key of ka) {
    if (!Object.prototype.hasOwnProperty.call(rb, key) || !sameValue(ra[key], rb[key]))
      return false;
  }
  return true;
}

class UserPool {
  private byId = new Map<unknown, unknown>();

  /** The pooled `user` equal to `user`, pooling it if it is the first for its id. */
  share(user: unknown): unknown {
    if (!user || typeof user !== 'object') return user;
    const id = (user as { id?: unknown }).id;
    if (id === undefined || id === null) return user;
    const pooled = this.byId.get(id);
    if (pooled === undefined) {
      this.byId.set(id, user);
      return user;
    }
    return isSameFeedUser(pooled, user) ? pooled : user;
  }
}

function shareItemUser<T extends WithUser>(item: T, pool: UserPool): T {
  if (!item || typeof item !== 'object' || !('user' in item)) return item;
  const user = pool.share(item.user);
  return user === item.user ? item : { ...item, user };
}

/**
 * The feed result with every equal `user` replaced by one shared object. Handles both shapes:
 * items that carry a `user` (`image.getInfinite`) and posts that carry a `user` plus `images`
 * that each carry one (`image.getImagesAsPostsInfinite`). Anything else passes through.
 */
export function shareFeedUsers<T>(result: T): T {
  if (!result || typeof result !== 'object') return result;
  const items = (result as { items?: unknown }).items;
  if (!Array.isArray(items)) return result;
  const pool = new UserPool();
  let changed = false;
  const shared = items.map((item: unknown) => {
    if (!item || typeof item !== 'object') return item;
    let next = shareItemUser(item as WithUser & { images?: unknown }, pool);
    const images = next.images;
    if (Array.isArray(images)) {
      let imagesChanged = false;
      const sharedImages = images.map((image: unknown) => {
        const out = shareItemUser(image as WithUser, pool);
        if (out !== image) imagesChanged = true;
        return out;
      });
      if (imagesChanged) next = { ...next, images: sharedImages };
    }
    if (next !== item) changed = true;
    return next;
  });
  return changed ? ({ ...result, items: shared } as T) : result;
}

const readSharedUsers = () => isFliptSync(FLIPT_FEATURE_FLAGS.IMAGE_FEED_SHARED_USERS);
// The fast superjson walk BAILS on a shared reference unless `trpc-fast-superjson-shared-refs` is
// on (a partial walk, then a full `superjson.serialize`), so sharing users with that flag off
// would make every superjson-written feed response slower. Sharing therefore needs BOTH flags.
// This is its own cached read of the flag (the response writer has another): the two can
// disagree for at most one refresh window, and either way the written values are identical.
const readSharedRefs = () => isFliptSync(FLIPT_FEATURE_FLAGS.TRPC_FAST_SUPERJSON_SHARED_REFS);

let gate = createCachedFlagGate(readSharedUsers);
let sharedRefsGate = createCachedFlagGate(readSharedRefs);

/** Tests only: forget the cached flag reads. */
export function resetFeedSharedUsersGateForTests() {
  gate = createCachedFlagGate(readSharedUsers);
  sharedRefsGate = createCachedFlagGate(readSharedRefs);
}

/**
 * `shareFeedUsers` while `image-feed-shared-users` AND `trpc-fast-superjson-shared-refs` are both
 * on; the result unchanged otherwise.
 */
export function withSharedFeedUsers<T>(result: T): T {
  return gate() && sharedRefsGate() ? shareFeedUsers(result) : result;
}
