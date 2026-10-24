/**
 * Zero imports, so the notification processors can build these URLs without pulling a component
 * graph into the job runner.
 */

export const STORYLINES_URL = '/storylines';

export function storylineUrl(storylineId: number) {
  return `${STORYLINES_URL}/${storylineId}`;
}

/** Where chapter 1 of an empty storyline is written: the post editor, already knowing its storyline. */
export function storylineWriteChapterUrl(storylineId: number) {
  return `/posts/create?storyline=${storylineId}`;
}

/**
 * Where a reader writes the chapter after `parentChapterId`: the post editor, already knowing which
 * chapter it continues. `n` only labels the page; the chapter's number is set by the route it is
 * read on.
 */
export function storylineContinueUrl({
  parentChapterId,
  chapterNumber,
}: {
  parentChapterId: number;
  chapterNumber: number;
}) {
  return `/posts/create?continues=${parentChapterId}&n=${chapterNumber}`;
}
