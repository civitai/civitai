import { getStorylineChapterName } from '~/components/Storyline/storyline-mode.utils';
import type { StorylinePathChapter } from '~/server/services/storyline.service';

type PathChapter = Pick<StorylinePathChapter, 'chapterId' | 'depth' | 'post' | 'tombstone'> & {
  joins?: Pick<StorylinePathChapter, 'chapterId' | 'depth' | 'post' | 'tombstone'>[];
};

export type StorylinePostParent = {
  chapterId: number;
  name: string;
  /** "ch 2", or "CivChan's ch 6" for a parent someone other than the storyline's owner wrote. */
  where: string;
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
    const number = `ch ${chapter.depth + 1}`;
    const author = chapter.post?.username;
    return {
      chapterId: chapter.chapterId,
      name: getStorylineChapterName(chapter),
      where: author && chapter.post?.userId !== ownerId ? `${author}'s ${number}` : number,
      href: chapter.post ? `/posts/${chapter.post.id}` : undefined,
    };
  };
  return [...(before ? [parent(before)] : []), ...(end.joins ?? []).map(parent)];
}
