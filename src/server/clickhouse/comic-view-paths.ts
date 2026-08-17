/**
 * Path parsing shared by the `pageViews` -> `daily_views` comic backfill.
 *
 * The regexes are strings because their real execution site is ClickHouse's `match()`/
 * `extractGroups()` (RE2), not JavaScript — the backfill interpolates these exact strings into
 * SQL. They are simple enough to mean the same thing in both engines (anchors, digit classes,
 * negated char class, no backreferences or lookaround), which is what lets the tests exercise
 * them as JS RegExp.
 */

/**
 * The project overview: `/comics/42`, `/comics/42/my-comic`, and anything else under
 * `/comics/<id>/` that the chapter pattern does not claim — because the page falls back to the
 * overview whenever it cannot read a chapter position out of the path. Tried SECOND, so a real
 * chapter path is never also counted as a project view.
 *
 * ⚠️ This matches on SHAPE, and it is only unambiguous because nothing static lives under
 * `/comics/<id>/`. The comic owner surface is `/comics/project/<id>/*`, excluded by name below.
 * If a static sibling route is ever added here — `/comics/<id>/edit`, `/comics/<id>/settings` —
 * it has the same shape as a slug, Next resolves the static route ahead of the `[[...slug]]`
 * catch-all, and this pattern starts silently counting owner traffic as reads, retroactively.
 * Adding such a route means excluding it here by name. (The equivalent trap is live in
 * /3d-models, where `<id>/edit` and `<id>/<slug>` are genuinely indistinguishable by shape.)
 */
export const PROJECT_PATH_RE = '^/comics/([0-9]+)([/?#]|$)';

/**
 * `/comics/42/my-comic/3/chapter-3` — the chapter reader. The position is 1-INDEXED.
 *
 * The position is always the SECOND segment after the id, because that is what the page reads
 * (`slug[1]`). A slug-less URL like `/comics/3156/1/chapter-1` therefore does NOT open chapter 1 —
 * the page parses `slug[1]` = 'chapter-1', gets NaN, and renders the overview. Those URLs are
 * matched by PROJECT_PATH_RE above, which is what the reader actually saw.
 */
export const CHAPTER_PATH_RE = '^/comics/([0-9]+)/[^/]+/([0-9]+)([/?#]|$)';

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
