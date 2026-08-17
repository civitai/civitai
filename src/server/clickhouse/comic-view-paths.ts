/**
 * Path parsing shared by the `pageViews` -> `daily_views` comic backfill.
 *
 * The regexes are strings because their real execution site is ClickHouse's `match()`/
 * `extractGroups()` (RE2), not JavaScript — the backfill interpolates these exact strings into
 * SQL. They are simple enough to mean the same thing in both engines (anchors, digit classes,
 * negated char class, no backreferences or lookaround), which is what lets the tests exercise
 * them as JS RegExp.
 */

/** `/comics/42` and `/comics/42/my-comic` — the project overview. */
export const PROJECT_PATH_RE = '^/comics/([0-9]+)(/[^/]*)?$';

/** `/comics/42/my-comic/3/chapter-3` — the chapter reader. The position is 1-INDEXED. */
export const CHAPTER_PATH_RE = '^/comics/([0-9]+)/[^/]+/([0-9]+)(/|$)';

export type ComicPageId =
  | { kind: 'project'; projectId: number }
  | { kind: 'chapter'; projectId: number; urlPosition: number }
  | { kind: 'other' };

/**
 * Classify a `pageViews.pageId`.
 *
 * `other` covers three unrelated things that all have to stay out of the reader numbers:
 * `/comics/project/<id>/*` (the authoring studio — the creator editing their own comic),
 * the index/browse/create pages (no project id), and the SQL-injection probe strings that
 * really do appear in this column.
 */
export function parseComicPageId(pageId: string): ComicPageId {
  const chapter = new RegExp(CHAPTER_PATH_RE).exec(pageId);
  if (chapter) {
    return {
      kind: 'chapter',
      projectId: Number(chapter[1]),
      urlPosition: Number(chapter[2]),
    };
  }

  const project = new RegExp(PROJECT_PATH_RE).exec(pageId);
  if (project) return { kind: 'project', projectId: Number(project[1]) };

  return { kind: 'other' };
}

/**
 * Resolve a 1-indexed URL chapter position to the `ComicChapter.id` a going-forward
 * `ComicChapterView` row would carry. `ComicChapter.position` is 0-indexed.
 *
 * Returns undefined when the position maps to no current chapter — deleted or reordered since
 * the view happened. Callers report that count rather than absorbing it.
 */
export function resolveChapterId(
  chapterIdByKey: Map<string, number>,
  projectId: number,
  urlPosition: number
) {
  return chapterIdByKey.get(chapterKey(projectId, urlPosition - 1));
}

export function chapterKey(projectId: number, position: number) {
  return `${projectId}:${position}`;
}
