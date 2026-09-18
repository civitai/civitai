import { describe, expect, it } from 'vitest';
import {
  REACTION_FETCH_CHUNK,
  mergeUserImageReactions,
  reactionQueryChunks,
} from '~/components/Reaction/useHydratedImageReactions';
import { getMyImageReactionsSchema } from '~/server/schema/reaction.schema';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';

const image = (id: number, reactions: { userId: number; reaction: ReviewReactions }[] = []) => ({
  id,
  reactions,
});

const VIEWER = 9266475;

describe('mergeUserImageReactions', () => {
  it('marks an image the shared cache handed over with no reactions', () => {
    const images = [image(142799705), image(2)];

    const merged = mergeUserImageReactions(images, { 142799705: ['Like', 'Heart'] }, VIEWER);

    expect(merged[0].reactions).toEqual([
      { userId: VIEWER, reaction: 'Like' },
      { userId: VIEWER, reaction: 'Heart' },
    ]);
    expect(merged[1].reactions).toEqual([]);
  });

  it('does not add a second copy of a reaction the payload already carried', () => {
    const images = [image(1, [{ userId: VIEWER, reaction: 'Like' }])];

    const merged = mergeUserImageReactions(images, { 1: ['Like'] }, VIEWER);

    expect(merged[0].reactions).toHaveLength(1);
    expect(merged).toBe(images);
  });

  it('adds only the reactions that are missing', () => {
    const images = [image(1, [{ userId: VIEWER, reaction: 'Like' }])];

    const merged = mergeUserImageReactions(images, { 1: ['Like', 'Cry'] }, VIEWER);

    expect(merged[0].reactions).toEqual([
      { userId: VIEWER, reaction: 'Like' },
      { userId: VIEWER, reaction: 'Cry' },
    ]);
  });

  it('keeps a reaction belonging to someone else and still adds the one belonging to the viewer', () => {
    const images = [image(1, [{ userId: 5, reaction: 'Like' }])];

    const merged = mergeUserImageReactions(images, { 1: ['Like'] }, VIEWER);

    expect(merged[0].reactions).toEqual([
      { userId: 5, reaction: 'Like' },
      { userId: VIEWER, reaction: 'Like' },
    ]);
  });

  it('returns the same array and the same elements when there is nothing to add', () => {
    const images = [image(1), image(2)];

    expect(mergeUserImageReactions(images, {}, VIEWER)).toBe(images);
    expect(mergeUserImageReactions(images, undefined, VIEWER)).toBe(images);
    // Per-element identity, not just the array: `ImagesProvider` and the card memos key off it,
    // and a fresh object for every untouched image re-renders the whole grid on each poll.
    const merged = mergeUserImageReactions(images, { 2: ['Like'] }, VIEWER);
    expect(merged[0]).toBe(images[0]);
    expect(merged[1]).not.toBe(images[1]);
  });
});

describe('mergeUserImageReactions on an item with no reactions field', () => {
  it('does not throw, and adds the viewer reactions', () => {
    // The collection blocks hand in a union of image/model/post/article items, so `reactions` is
    // optional. Before the `?? []` this threw inside the render body of a front-page block.
    const items = [{ id: 1 } as { id: number; reactions?: never[] }];

    expect(mergeUserImageReactions(items, { 1: ['Like'] }, VIEWER)[0].reactions).toEqual([
      { userId: VIEWER, reaction: 'Like' },
    ]);
  });
});

describe('reactionQueryChunks', () => {
  const ids = Array.from({ length: 150 }, (_, i) => i + 1);

  it('asks for nothing when there is no viewer', () => {
    // `reaction.getMyImageReactions` is a protectedProcedure and most front-page traffic is
    // signed out, so losing this gate is one UNAUTHORIZED request per home block per visitor.
    expect(reactionQueryChunks(ids, undefined, 'image')).toEqual([]);
  });

  it.each(['model', 'post', 'article'] as const)('asks for nothing on a %s surface', (entity) => {
    expect(reactionQueryChunks(ids, VIEWER, entity)).toEqual([]);
  });

  it('chunks a signed-in viewer ids without dropping any', () => {
    const chunks = reactionQueryChunks(ids, VIEWER, 'image');

    expect(chunks.map((c) => c.length)).toEqual([100, 50]);
    expect(chunks.flat()).toEqual(ids);
  });

  it('asks in a stable order, so a second visit to the page can reuse the answer', () => {
    // Every home block shuffles its pool on mount. Without the sort the query key is different
    // every time and `staleTime` protects nothing — the same ids are re-fetched on every visit.
    //
    // REVERSED rather than randomised: a random permutation can come back near-identity, and a
    // control that is only almost-surely red is not a control.
    const reversed = [...ids].reverse();

    expect(reactionQueryChunks(reversed, VIEWER, 'image')).toEqual(
      reactionQueryChunks(ids, VIEWER, 'image')
    );
  });

  it('does not sort the caller array in place', () => {
    // The pool belongs to the React Query cache, and `useShuffled` already copies before shuffling
    // for the same reason.
    const caller = [3, 1, 2];
    reactionQueryChunks(caller, VIEWER, 'image');

    expect(caller).toEqual([3, 1, 2]);
  });

  it('keeps every chunk inside what the server will accept', () => {
    // Two copies of one number: the chunk size here and the `.max()` on the input schema. If they
    // diverge the chunk fails zod, React Query swallows it, and the grid silently stays
    // un-hydrated — the original bug, with no signal anywhere.
    const full = Array.from({ length: REACTION_FETCH_CHUNK }, () => 1);

    expect(getMyImageReactionsSchema.safeParse({ imageIds: full }).success).toBe(true);
    expect(getMyImageReactionsSchema.safeParse({ imageIds: [...full, 2] }).success).toBe(false);
  });
});
