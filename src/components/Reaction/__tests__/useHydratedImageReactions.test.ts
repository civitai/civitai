import { describe, expect, it } from 'vitest';
import { mergeUserImageReactions } from '~/components/Reaction/useHydratedImageReactions';
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
    // `Reactions` matches on userId AND reaction, so a reaction credited to anyone else would
    // leave the button un-highlighted while looking hydrated in a snapshot.
    expect(merged[0].reactions.every((r) => r.userId === VIEWER)).toBe(true);
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
