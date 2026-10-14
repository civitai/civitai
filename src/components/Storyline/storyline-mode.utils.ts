import type { StorylinePathChapter } from '~/server/services/storyline.service';

/**
 * Storyline mode lives in the URL, as the end chapter of the path being read. Image detail
 * carries the query string through every navigation, so the mode survives paging and a shared
 * link opens in the storyline; dropping the param is what leaving does.
 */
export const STORYLINE_CHAPTER_PARAM = 'storylineChapter';

export function parseIdParam(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/** Path order first, then each post's own image order: the image query itself orders by recency. */
export function orderPathImages<
  T extends { id: number; postId: number | null; index: number | null }
>(images: T[], postIds: number[]) {
  const position = new Map(postIds.map((id, i) => [id, i]));
  return images
    .filter((image) => image.postId != null && position.has(image.postId))
    .sort(
      (a, b) =>
        (position.get(a.postId as number) ?? 0) - (position.get(b.postId as number) ?? 0) ||
        (a.index ?? 0) - (b.index ?? 0) ||
        a.id - b.id
    );
}

export function getStorylineWalk(
  chapters: StorylinePathChapter[],
  images: { id: number; postId: number | null }[]
) {
  const chapterIdByPostId = new Map<number, number>();
  for (const chapter of chapters)
    if (chapter.post) chapterIdByPostId.set(chapter.post.id, chapter.chapterId);

  const chapterIdByImageId = new Map<number, number>();
  const firstImageIdByChapterId = new Map<number, number>();
  for (const image of images) {
    const chapterId = image.postId != null ? chapterIdByPostId.get(image.postId) : undefined;
    if (chapterId == null) continue;
    chapterIdByImageId.set(image.id, chapterId);
    if (!firstImageIdByChapterId.has(chapterId)) firstImageIdByChapterId.set(chapterId, image.id);
  }
  return { chapterIdByImageId, firstImageIdByChapterId };
}

const tombstoneLabels: Record<NonNullable<StorylinePathChapter['tombstone']>, string> = {
  deleted: 'This chapter was deleted',
  removed: 'This chapter was removed',
  unavailable: 'This chapter is not available',
  aboveStoryRating: "This chapter is rated above the storyline's maximum",
  browsingLevel: 'This chapter is hidden by your browsing level',
};

export function getStorylineTombstoneLabel(reason: NonNullable<StorylinePathChapter['tombstone']>) {
  return tombstoneLabels[reason];
}

/**
 * A chapter by someone the reader hid reads as unavailable, like one by someone they blocked:
 * the server only knows about blocks, and the image read already drops hidden users' images.
 */
export function hideHiddenUsersChapters<
  T extends { tombstone: StorylinePathChapter['tombstone']; post: { userId: number } | null }
>(chapters: T[], hiddenUserIds: ReadonlySet<number>): T[] {
  if (!hiddenUserIds.size) return chapters;
  return chapters.map((chapter) =>
    chapter.post && hiddenUserIds.has(chapter.post.userId)
      ? ({ ...chapter, tombstone: 'unavailable', post: null } as T)
      : chapter
  );
}

export type PendingContinue =
  | { kind: 'wait' }
  | { kind: 'open'; imageId: number }
  | { kind: 'end' };

/**
 * After a reader takes a branch: wait until the branch's path and images have arrived, then open
 * its first image, or, when it has none this reader can see, show its end-of-chapter view so
 * what follows a hidden chapter stays reachable.
 */
export function resolvePendingContinue({
  pendingChapterId,
  pathEndId,
  imagesFetching,
  firstImageIdByChapterId,
}: {
  pendingChapterId: number;
  pathEndId: number | undefined;
  imagesFetching: boolean;
  firstImageIdByChapterId: ReadonlyMap<number, number>;
}): PendingContinue {
  if (pathEndId !== pendingChapterId || imagesFetching) return { kind: 'wait' };
  const imageId = firstImageIdByChapterId.get(pendingChapterId);
  return imageId ? { kind: 'open', imageId } : { kind: 'end' };
}

/** A storyline is walked, not looped: past its last image is the end-of-chapter view. */
export function getStorylineStep(index: number, length: number, direction: 'next' | 'previous') {
  if (direction === 'next') return index >= length - 1 ? 'end' : 'move';
  return index > 0 ? 'move' : 'stay';
}

/** Carousel navigation that stops at a storyline's ends; outside one (`onEnd` absent) it loops. */
export function withStorylineNavigation<
  T extends { index: number; next: () => void; previous: () => void }
>(navigation: T, length: number, onEnd: (() => void) | undefined): T {
  if (!onEnd) return navigation;
  return {
    ...navigation,
    next: () => {
      if (getStorylineStep(navigation.index, length, 'next') === 'end') onEnd();
      else navigation.next();
    },
    previous: () => {
      if (getStorylineStep(navigation.index, length, 'previous') === 'move') navigation.previous();
    },
  };
}

export function uniquePostIds(images: { postId?: number | null }[] | undefined) {
  return [...new Set((images ?? []).flatMap((image) => (image.postId ? [image.postId] : [])))];
}

/**
 * Path images page until the path is whole, so an image deep in a long path counts as on it.
 * A failed page stops the paging instead of re-requesting it in a loop, and stops counting as
 * loading, so a reader waiting on a branch is not held forever.
 */
export function getPathImagesPaging({
  hasNextPage,
  isFetching,
  isError,
  pages,
  maxPages,
}: {
  hasNextPage: boolean;
  isFetching: boolean;
  isError: boolean;
  pages: number;
  maxPages: number;
}) {
  const wantsMore = hasNextPage && !isError && pages < maxPages;
  return { fetchNext: wantsMore && !isFetching, loading: isFetching || wantsMore };
}

/** A chapter's name: its post's title, else its number (and author, where nothing else shows it). */
export function getStorylineChapterName(
  chapter: Pick<StorylinePathChapter, 'depth' | 'post' | 'tombstone'>,
  { withAuthor = false }: { withAuthor?: boolean } = {}
) {
  if (!chapter.post) return getStorylineTombstoneLabel(chapter.tombstone ?? 'deleted');
  const number = `Chapter ${chapter.depth + 1}`;
  const author = withAuthor && chapter.post.username ? ` by ${chapter.post.username}` : '';
  return chapter.post.title || `${number}${author}`;
}

type SubwayChapter = Pick<StorylinePathChapter, 'chapterId' | 'depth' | 'post' | 'tombstone'>;
export type SubwayStop<T extends SubwayChapter> = {
  chapter: SubwayChapter;
  /** On the path being read (walked), or on the canon line ahead of its end. */
  kind: 'path' | 'ahead';
  /** Continuations leaving this stop other than the next stop on the line. */
  branches: T[];
};

/**
 * The drawer's line: the path being read, then the canon chapters after its end, with every
 * other continuation hung off the stop it leaves from.
 */
export function buildSubwayStops<T extends SubwayChapter>(
  path: SubwayChapter[],
  ahead: SubwayChapter[],
  childrenByChapterId: ReadonlyMap<number, T[]>
): SubwayStop<T>[] {
  const line = [
    ...path.map((chapter) => ({ chapter, kind: 'path' as const })),
    ...ahead.map((chapter) => ({ chapter, kind: 'ahead' as const })),
  ];
  return line.map((stop, i) => {
    const next = line[i + 1]?.chapter.chapterId;
    const branches = (childrenByChapterId.get(stop.chapter.chapterId) ?? []).filter(
      (child) => child.chapterId !== next
    );
    return { ...stop, branches };
  });
}
