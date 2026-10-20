import { UnstyledButton } from '@mantine/core';
import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { useMemo } from 'react';
import type { ActiveStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import {
  useStorylineCanonAhead,
  useStorylinePathLanes,
} from '~/components/Storyline/storyline.queries';
import { laneColor } from '~/components/Storyline/storyline-lane-map.utils';
import { getStorylineChapterName } from '~/components/Storyline/storyline-mode.utils';
import type { StorylineRailSegment } from '~/components/Storyline/storyline-rail.utils';
import { buildStorylineRail } from '~/components/Storyline/storyline-rail.utils';

const STUB = 'pointer-events-none absolute bottom-1/2 h-2.5 w-0.5 bg-[var(--mantine-color-pink-5)]';

/**
 * Storyline-mode replacement for the carousel dots. The pink stubs are marks only: the map lists
 * forks for the stops nearest the end alone.
 */
export function StorylineChapterRail({
  storyline,
  images,
  index,
  navigate,
}: {
  storyline: ActiveStorylineMode;
  /** The carousel's own items, which `index` points into: not always the walked images alone. */
  images: { id: number }[];
  index: number;
  navigate: (index: number) => void;
}) {
  const { path, chapterIdOfImage, jumpToChapter, continueTo } = storyline;
  const end = path.chapters[path.chapters.length - 1];
  const canonAhead = useStorylineCanonAhead(end?.chapterId, { enabled: true, forks: false });
  type RailLineChapter = (typeof path.chapters)[number] | (typeof canonAhead.ahead)[number];
  const laneOf = useStorylinePathLanes(path.storyline.id, path.chapters);
  const rail = useMemo(
    () =>
      buildStorylineRail<RailLineChapter>({
        path: path.chapters,
        ahead: canonAhead.ahead,
        imageChapterIds: images.map((image) => chapterIdOfImage(image.id)),
        index,
        aheadKnown: canonAhead.isSuccess,
        laneOf,
      }),
    [path.chapters, canonAhead.ahead, canonAhead.isSuccess, images, chapterIdOfImage, index, laneOf]
  );
  // jumpToChapter opens a chapter's first walked image, so a chapter with none cannot be jumped to.
  const readable = useMemo(
    () => new Set(storyline.images.map((image) => chapterIdOfImage(image.id))),
    [storyline.images, chapterIdOfImage]
  );

  const open = (segment: StorylineRailSegment<(typeof rail.line)[number]>) => {
    if (segment.kind === 'path') return jumpToChapter(segment.chapter.chapterId);
    const before = rail.line[rail.line.indexOf(segment.chapter) - 1];
    continueTo(segment.chapter, { track: false, from: before?.chapterId, line: rail.line });
  };

  return (
    <nav
      aria-label="Chapters"
      className="mx-auto flex h-4 w-full max-w-[420px] items-center gap-1.5"
      data-testid="storyline-rail"
    >
      {rail.clippedStart && <Ellipsis label="Earlier chapters not shown" />}
      {rail.segments.map((segment) => {
        const { chapter, kind, current, leaves, joins, ticks, lane } = segment;
        const label = railLabel(segment);
        return (
          <div
            key={chapter.chapterId}
            className="relative flex h-full min-w-0 items-center"
            style={{ flex: current ? Math.min(Math.max(ticks.length, 3), 8) : 1 }}
            data-testid="storyline-rail-segment"
            data-chapter-id={chapter.chapterId}
            data-kind={kind}
            data-current={current || undefined}
            data-lane={lane ?? undefined}
          >
            {joins && (
              <span
                aria-hidden
                className={clsx(STUB, '-left-1 origin-bottom -rotate-45')}
                data-testid="storyline-rail-join"
              />
            )}
            {current ? (
              <div
                role="group"
                aria-label={label}
                aria-current="step"
                className="flex size-full items-center gap-0.5 rounded-full bg-white/15 px-1.5 ring-1 ring-white/40"
                style={
                  lane === null
                    ? undefined
                    : ({
                        background: `color-mix(in srgb, ${laneColor(lane)} 30%, transparent)`,
                        '--tw-ring-color': laneColor(lane),
                      } as CSSProperties)
                }
              >
                {ticks.map((imageIndex, i) => (
                  <UnstyledButton
                    key={imageIndex}
                    onClick={() => navigate(imageIndex)}
                    aria-label={`Image ${i + 1} of ${ticks.length}`}
                    aria-current={imageIndex === index || undefined}
                    className={clsx(
                      'h-1 min-w-0 flex-1 rounded',
                      imageIndex === index ? 'bg-blue-6 dark:bg-white' : 'bg-white/60'
                    )}
                    data-testid="storyline-rail-tick"
                  />
                ))}
              </div>
            ) : (
              <UnstyledButton
                onClick={() => open(segment)}
                // Ahead, a tombstone stays passable: continuing into it opens its end view.
                disabled={kind === 'path' && !readable.has(chapter.chapterId)}
                aria-label={label}
                className="flex size-full items-center"
              >
                <span
                  className={clsx(
                    'h-1 w-full rounded border border-solid border-gray-4 shadow-2xl',
                    !chapter.post ? 'bg-gray-6' : lane === null && 'bg-white',
                    kind === 'ahead' ? 'opacity-30' : 'dark:opacity-60'
                  )}
                  // A tombstoned chapter keeps its plain grey, whatever lane it sat in.
                  style={
                    lane !== null && chapter.post
                      ? { background: laneColor(lane), borderColor: laneColor(lane) }
                      : undefined
                  }
                />
              </UnstyledButton>
            )}
            {leaves && (
              <span
                aria-hidden
                className={clsx(STUB, '-right-1 origin-bottom rotate-45')}
                data-testid="storyline-rail-leave"
              />
            )}
          </div>
        );
      })}
      {rail.clippedEnd && <Ellipsis label="Later chapters not shown" />}
    </nav>
  );
}

function railLabel({
  chapter,
  kind,
  depth,
  leaves,
  joins,
}: StorylineRailSegment<Parameters<typeof getStorylineChapterName>[0] & { chapterId: number }>) {
  // An untitled chapter's name is its number, which the label already starts with.
  const name = chapter.post && !chapter.post.title ? '' : `: ${getStorylineChapterName(chapter)}`;
  return [
    `Chapter ${depth + 1}${name}`,
    kind === 'ahead' && 'canon ahead',
    joins && 'another path joins here',
    leaves && 'another path leaves after it',
  ]
    .filter(Boolean)
    .join(', ');
}

function Ellipsis({ label }: { label: string }) {
  return (
    <span className="shrink-0 text-xs leading-none text-white/70">
      <span aria-hidden>…</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
