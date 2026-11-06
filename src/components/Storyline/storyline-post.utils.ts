import { getStorylineChapterName } from '~/components/Storyline/storyline-mode.utils';
import type { StorylinePathChapter } from '~/server/services/storyline.service';

type PathChapter = Pick<StorylinePathChapter, 'chapterId' | 'depth' | 'post' | 'tombstone'> & {
  joins?: Pick<StorylinePathChapter, 'chapterId' | 'depth' | 'post' | 'tombstone'>[];
};

export type StorylinePostParent = {
  chapterId: number;
  name: string;
  /**
   * "ch 2", or "CivChan's ch 6" for a parent someone other than the storyline's owner wrote.
   * Absent where the name is already the number and nothing else needs adding: a parent this
   * reader may not see, or the owner's untitled chapter.
   */
  where?: string;
  /** The parent's post page; absent for a chapter this reader may not see. */
  href?: string;
};

/**
 * Parents to offer on a chapter's post page: the previous chapter on the path, then every other
 * parent where branches rejoin. A post page carries no `via` route, so all are listed.
 */
export function getStorylinePostParents(
  path: PathChapter[],
  ownerId: number
): StorylinePostParent[] {
  const end = path[path.length - 1];
  const before = path[path.length - 2];
  if (!end) return [];
  const parent = (chapter: PathChapter): StorylinePostParent => {
    // Plain "Chapter 3": nothing about why it is hidden, and no second "(ch 3)".
    if (!chapter.post)
      return {
        chapterId: chapter.chapterId,
        name: getStorylineChapterName(chapter, { inSentence: true }),
      };
    const number = `ch ${chapter.depth + 1}`;
    const author = chapter.post.username;
    const byAnother = !!author && chapter.post.userId !== ownerId;
    return {
      chapterId: chapter.chapterId,
      name: getStorylineChapterName(chapter),
      // An untitled chapter is already named by its number: only another author is worth adding.
      where: byAnother ? `${author}'s ${number}` : chapter.post.title ? number : undefined,
      href: `/posts/${chapter.post.id}`,
    };
  };
  return [...(before ? [parent(before)] : []), ...(end.joins ?? []).map(parent)];
}
