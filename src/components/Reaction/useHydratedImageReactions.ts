import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import { chunkIds } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';

/** Must not exceed the `imageIds` cap on `getMyImageReactionsSchema`, which is pinned by a test. */
export const REACTION_FETCH_CHUNK = 100;

// `reactions` OPTIONAL so a model, post or article item satisfies this structurally. That is what
// lets the collection blocks pass their union straight in, instead of casting at the call site —
// and a cast at the call site is what would hide a payload that stopped carrying `reactions`.
type HydratableImage = { id: number; reactions?: { userId: number; reaction: ReviewReactions }[] };

/**
 * The id lists this surface will ask about, or none at all.
 *
 * 🔴 Returning `[]` for a signed-out viewer is load-bearing, not a micro-optimisation:
 * `reaction.getMyImageReactions` is a `protectedProcedure`, and the front page's majority
 * traffic is signed out. Without this gate every anonymous visitor fires an UNAUTHORIZED
 * request per home block.
 */
export function reactionQueryChunks(
  imageIds: number[],
  userId: number | undefined,
  enabled: boolean
): number[][] {
  if (!userId || !enabled) return [];
  // SORTED here, and deliberately not inside `chunkIds`, whose contract is insertion order: its
  // other callers page, and a feed that appends lower ids would have every chunk boundary shift
  // under it. A home block is the opposite — it never appends, it asks about its whole pool, and
  // the only thing that varies between mounts is the shuffle. Sorting makes the key repeat, which
  // is the only thing that makes `staleTime` below worth anything.
  return chunkIds(
    [...imageIds].sort((a, b) => a - b),
    REACTION_FETCH_CHUNK
  );
}

/**
 * Add the viewer's own reactions to images that were served without them.
 *
 * Returns the SAME array and the same element references when there is nothing to add, so a
 * surface that already carries reactions pays no re-render and no broken memo.
 */
export function mergeUserImageReactions<T extends HydratableImage>(
  images: T[],
  byImageId: Record<number, ReviewReactions[]> | undefined,
  userId: number
): T[] {
  if (!byImageId) return images;

  let changed = false;
  const merged = images.map((image) => {
    const mine = byImageId[image.id];
    if (!mine?.length) return image;

    // A surface can hand us reactions AND be hydrated — the collection home block renders the
    // same card component the gallery does. Appending blind would give one image two Likes from
    // one user, and `Reactions` counts a reaction as given by finding the first match, so the
    // duplicate is invisible until something sums them.
    //
    // `?? []` because `reactions` is optional on this type, so the collection blocks can pass a
    // union of image/model/post/article items in without a cast. It protects the merge only:
    // `ReactionsList` dereferences `reactions` unguarded, so a payload that dropped the field
    // would still throw, one component further down.
    const existing = image.reactions ?? [];
    const missing = mine.filter(
      (reaction) => !existing.some((x) => x.userId === userId && x.reaction === reaction)
    );
    if (!missing.length) return image;

    changed = true;
    return {
      ...image,
      reactions: [...existing, ...missing.map((reaction) => ({ userId, reaction }))],
    } as T;
  });

  return changed ? merged : images;
}

/**
 * The viewer's reaction state for a surface whose payload could not carry it.
 *
 * Home blocks are served from a Redis entry with no user segment AND through `edgeCacheIt`, so
 * every viewer — signed in or not — is handed the same objects with `reactions: []`. That is not
 * cosmetic: `reaction.toggle` acts on the DB row, not on what is drawn, so a viewer who sees
 * their own reaction un-highlighted and clicks it DELETES it.
 *
 * 🔴 CALL THIS ON THE LIST YOU GO ON TO RENDER, and keep it the only binding — pass it straight
 * into the dedupe rather than holding the un-hydrated array in a variable of its own. Two
 * bindings is how this silently comes undone: rendering the other one restores the bug in full
 * while the hook call, and so the guard that reads for it, stay in place.
 *
 * COST, measured on prod 2026-09-18: one request per image-rendering SECTION, which on today's
 * home page is 9 — a FeaturedCollections block renders one section per pick and its `renderCount`
 * is 5, and one of the three Feed blocks carries models and asks nothing. Each is an Index Only
 * Scan on `ImageReaction_imageId_userId_reaction_key`, 0.4–1.2 ms over a block's whole pre-cap
 * pool; ~4.6 ms of replica time for the page. These queries deliberately do NOT set `skipBatch`,
 * so they collapse into one request when tRPC batching ramps.
 *
 * `useEngagedModelMembership` solves the same problem class — per-viewer state keyed by entity
 * id, overlaid on a payload that arrived shared — and solves it BETTER, with a module-level
 * batcher that coalesces across surfaces into one request and a persisted already-known set. It
 * is already on this page, under `ModelCard`. Reactions deliberately do not use it: different
 * entity, different endpoint, different store, and fusing them would couple two features that
 * only rhyme. If a SECOND cached surface ever needs reaction hydration, adopt that batcher's
 * shape here rather than writing the per-surface one a third time.
 *
 * 🔴 KNOWN, and not closed by this: a chunk that ERRORS contributes nothing and the merge becomes
 * a no-op, so the cards degrade to exactly the un-highlighted state that gets a reaction clicked
 * off — silently, with nothing surfaced to the viewer or to telemetry. Same for the window before
 * the first response lands. Both are closed by the same lever, which is not showing an un-given
 * state until the lookup settles, or by making `reaction.toggle` carry the viewer's intent so the
 * click cannot be destructive in the first place.
 */
export function useHydratedImageReactions<T extends HydratableImage>(
  images: T[],
  { enabled = true }: { enabled?: boolean } = {}
): T[] {
  const currentUser = useCurrentUser();
  const userId = currentUser?.id;

  const chunks = useMemo(
    () =>
      reactionQueryChunks(
        images.map((image) => image.id),
        userId,
        enabled
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [images.map((image) => image.id).join(','), userId, enabled]
  );

  const queries = trpc.useQueries((t) =>
    chunks.map((chunk) =>
      t.reaction.getMyImageReactions({ imageIds: chunk }, { staleTime: 60_000 })
    )
  );

  const byImageId = useMemo(
    () => Object.assign({}, ...queries.map((query) => query.data ?? {})),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queries.map((query) => query.dataUpdatedAt).join(',')]
  ) as Record<number, ReviewReactions[]>;

  return useMemo(
    () => (userId ? mergeUserImageReactions(images, byImageId, userId) : images),
    [images, byImageId, userId]
  );
}
