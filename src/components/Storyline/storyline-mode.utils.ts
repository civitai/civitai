import type { StorylinePathChapter } from '~/server/services/storyline.service';

/**
 * Storyline mode lives in the URL, as the end chapter of the path being read. Image detail
 * carries the query string through every navigation, so the mode survives paging and a shared
 * link opens in the storyline; dropping the param is what leaving does.
 */
export const STORYLINE_CHAPTER_PARAM = 'storylineChapter';

export function parseStorylineChapterParam(value: unknown) {
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
