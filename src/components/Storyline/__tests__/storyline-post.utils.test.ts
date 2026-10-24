import { describe, expect, it } from 'vitest';
import { getStorylinePostParents } from '~/components/Storyline/storyline-post.utils';

const CIVBOT = 1;
const CIVCHAN = 2;
const chapter = (chapterId: number, depth: number, title: string | null, userId = CIVBOT) => ({
  chapterId,
  depth,
  tombstone: null,
  post: {
    id: chapterId * 100,
    title,
    userId,
    username: userId === CIVBOT ? 'CivBot' : 'CivChan',
  },
});

describe('getStorylinePostParents', () => {
  it('offers the chapter before it on a plain path', () => {
    const parents = getStorylinePostParents(
      [
        chapter(10, 0, 'Beep Boop'),
        chapter(11, 1, 'Ask Me Anything'),
        chapter(12, 2, 'Nothing to See Here'),
      ],
      CIVBOT
    );
    expect(parents).toEqual([
      { chapterId: 11, name: 'Ask Me Anything', where: 'ch 2', href: '/posts/1100' },
    ]);
  });

  it('at a rejoin, offers every parent with its link, naming the author who is not the owner', () => {
    const parents = getStorylinePostParents(
      [
        chapter(14, 4, 'Gym Rules'),
        chapter(15, 5, 'More Personality'),
        {
          ...chapter(19, 6, 'Glitch Detected'),
          joins: [chapter(18, 5, 'Be My Valentine', CIVCHAN)],
        },
      ],
      CIVBOT
    );
    expect(parents).toEqual([
      { chapterId: 15, name: 'More Personality', where: 'ch 6', href: '/posts/1500' },
      { chapterId: 18, name: 'Be My Valentine', where: "CivChan's ch 6", href: '/posts/1800' },
    ]);
  });

  it("names by the storyline's owner, not by which parent the path happened to take", () => {
    // The path came up the other author's branch; the owner's chapter joins.
    const parents = getStorylinePostParents(
      [
        chapter(17, 4, 'Members Only', CIVCHAN),
        chapter(18, 5, 'Be My Valentine', CIVCHAN),
        { ...chapter(19, 6, 'Glitch Detected'), joins: [chapter(15, 5, 'More Personality')] },
      ],
      CIVBOT
    );
    expect(parents.map((p) => p.where)).toEqual(["CivChan's ch 6", 'ch 6']);
  });

  it('gives a parent this reader may not see no link', () => {
    const removed = { chapterId: 11, depth: 1, tombstone: 'removed' as const, post: null };
    const [parent] = getStorylinePostParents([removed, chapter(12, 2, null)], CIVBOT);
    expect(parent).toEqual({
      chapterId: 11,
      name: 'This chapter was removed',
      where: 'ch 2',
      href: undefined,
    });
  });

  it('offers nothing before chapter 1', () => {
    expect(getStorylinePostParents([chapter(10, 0, 'Beep Boop')], CIVBOT)).toEqual([]);
  });
});
