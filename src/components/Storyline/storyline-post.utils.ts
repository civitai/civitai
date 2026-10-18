import { getStorylineChapterName } from '~/components/Storyline/storyline-mode.utils';
import type { StorylinePathChapter } from '~/server/services/storyline.service';

type PathChapter = Pick<StorylinePathChapter, 'chapterId' | 'depth' | 'post' | 'tombstone'> & {
  joins?: Pick<StorylinePathChapter, 'chapterId' | 'depth' | 'post' | 'tombstone'>[];
};

export type StorylinePostParent = {
  chapterId: number;
  name: string;
  /** "ch 2", or "CivChan's ch 6" for a parent another author wrote on a branch that joins here. */
  where: string;
  /** The parent's post page; absent for a chapter this reader may not see. */
  href?: string;
};

/**
 * The ways into a chapter, for its post page: the chapter before it on its path, then, where
 * branches rejoin, every other parent. A post page has no route, so all of them are offered.
 */
export function getStorylinePostParents(path: PathChapter[]): StorylinePostParent[] {
  const end = path[path.length - 1];
  const before = path[path.length - 2];
  if (!end) return [];
  const routeAuthor = before?.post?.userId ?? end.post?.userId;
  const parent = (chapter: PathChapter, onPath: boolean): StorylinePostParent => {
    const number = `ch ${chapter.depth + 1}`;
    const author = chapter.post?.username;
    return {
      chapterId: chapter.chapterId,
      name: getStorylineChapterName(chapter),
      where:
        !onPath && author && chapter.post?.userId !== routeAuthor
          ? `${author}'s ${number}`
          : number,
      href: chapter.post ? `/posts/${chapter.post.id}` : undefined,
    };
  };
  return [
    ...(before ? [parent(before, true)] : []),
    ...(end.joins ?? []).map((join) => parent(join, false)),
  ];
}
