import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

/** Matches the `imageIds` cap on `getMyImageReactionsSchema`. */
const REACTION_FETCH_CHUNK = 100;

type HydratableImage = { id: number; reactions: { userId: number; reaction: ReviewReactions }[] };

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
    const missing = mine.filter(
      (reaction) => !image.reactions.some((x) => x.userId === userId && x.reaction === reaction)
    );
    if (!missing.length) return image;

    changed = true;
    return {
      ...image,
      reactions: [...image.reactions, ...missing.map((reaction) => ({ userId, reaction }))],
    };
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
 * Shaped after `StickerPlacementBatchProvider`: one batched lookup per surface rather than one
 * per card, chunked in ARRIVAL order so a chunk's key stops changing once it is full.
 */
export function useHydratedImageReactions<T extends HydratableImage>(images: T[]): T[] {
  const currentUser = useCurrentUser();
  const userId = currentUser?.id;

  const chunks = useMemo(() => {
    if (!userId) return [] as number[][];
    const unique = [...new Set(images.map((image) => image.id))];
    const result: number[][] = [];
    for (let i = 0; i < unique.length; i += REACTION_FETCH_CHUNK)
      result.push(unique.slice(i, i + REACTION_FETCH_CHUNK));
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images.map((image) => image.id).join(','), userId]);

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
