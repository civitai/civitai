import type { StorylinePathChapter } from '~/server/services/storyline.service';

/** Past this many chapters the rail shows a window around the current one. */
export const STORYLINE_RAIL_WINDOW = 24;

type RailChapter = Pick<StorylinePathChapter, 'chapterId' | 'depth' | 'post'> & {
  childCount?: number;
  joins?: unknown[];
};

export type StorylineRailSegment<T extends RailChapter> = {
  chapter: T;
  /** On the path being read, or on the canon line ahead of its end. */
  kind: 'path' | 'ahead';
  /** The chapter's number on the line, from 0, as the drawer numbers it. */
  depth: number;
  current: boolean;
  /** Another path leaves after this chapter: a way on besides the next chapter on the line. */
  leaves: boolean;
  /** Another path joins the line at this chapter. */
  joins: boolean;
  /** The current chapter's images, as indexes into the carousel's images. Empty on the others. */
  ticks: number[];
};

/**
 * The viewer's chapter rail: one segment per chapter on the reader's line (the path, then the
 * canon line ahead), with ticks for the current chapter's images only.
 */
export function buildStorylineRail<T extends RailChapter>({
  path,
  ahead,
  imageChapterIds,
  index,
  aheadKnown,
  window = STORYLINE_RAIL_WINDOW,
}: {
  path: T[];
  ahead: T[];
  /** The chapter of each carousel image, in carousel order (undefined off the path). */
  imageChapterIds: (number | undefined)[];
  /** The carousel image being shown. */
  index: number;
  /** Whether the canon line ahead has arrived. Until it has, the path's end is not marked as forking. */
  aheadKnown: boolean;
  window?: number;
}) {
  const line = [
    ...path.map((chapter) => ({ chapter, kind: 'path' as const })),
    ...ahead.map((chapter) => ({ chapter, kind: 'ahead' as const })),
  ];
  const currentId = imageChapterIds[index] ?? path[path.length - 1]?.chapterId;
  const ticks = imageChapterIds.flatMap((id, i) => (id === currentId ? [i] : []));

  const segments: StorylineRailSegment<T>[] = line.map(({ chapter, kind }, i) => {
    // Every stop but the last has the next stop among its ways on, so it forks only past one.
    const onward = i < line.length - 1 || !aheadKnown ? 1 : 0;
    const current = chapter.chapterId === currentId;
    return {
      chapter,
      kind,
      depth: (path[0]?.depth ?? 0) + i,
      current,
      leaves: (chapter.childCount ?? 0) > onward,
      joins: (chapter.joins?.length ?? 0) > 0,
      ticks: current ? ticks : [],
    };
  });

  const currentAt = Math.max(
    0,
    segments.findIndex((s) => s.current)
  );
  const start = Math.min(
    Math.max(0, currentAt - Math.floor(window / 2)),
    Math.max(0, segments.length - window)
  );
  const end = Math.min(segments.length, start + window);
  return {
    segments: segments.slice(start, end),
    clippedStart: start > 0,
    clippedEnd: end < segments.length,
    line: line.map(({ chapter }) => chapter),
  };
}
