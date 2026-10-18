import { UnstyledButton } from '@mantine/core';
import clsx from 'clsx';
import { useMemo } from 'react';
import type { ActiveStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import { useStorylineCanonAhead } from '~/components/Storyline/storyline.queries';
import { getStorylineChapterName } from '~/components/Storyline/storyline-mode.utils';
import type { StorylineRailSegment } from '~/components/Storyline/storyline-rail.utils';
import { buildStorylineRail } from '~/components/Storyline/storyline-rail.utils';

const STUB = 'absolute bottom-1/2 h-2.5 w-0.5 bg-[var(--mantine-color-pink-5)]';

/**
 * Image detail's dots in storyline mode: a fixed-width rail of the reader's line, one segment per
 * chapter, where only the current chapter opens into a tick per image. Pink stubs mark where other
 * paths leave and join; they open the map, which lists them.
 */
export function StorylineChapterRail({
  storyline,
  index,
  navigate,
}: {
  storyline: ActiveStorylineMode;
  index: number;
  navigate: (index: number) => void;
}) {
  const { path, images, chapterIdOfImage, jumpToChapter, continueTo, setDrawerOpen } = storyline;
  const end = path.chapters[path.chapters.length - 1];
  const canonAhead = useStorylineCanonAhead(end?.chapterId, { enabled: true, forks: false });
  type RailLineChapter = (typeof path.chapters)[number] | (typeof canonAhead.ahead)[number];
  const rail = useMemo(
    () =>
      buildStorylineRail<RailLineChapter>({
        path: path.chapters,
        ahead: canonAhead.ahead,
        imageChapterIds: images.map((image) => chapterIdOfImage(image.id)),
        index,
        aheadKnown: !canonAhead.isLoading,
      }),
    [path.chapters, canonAhead.ahead, canonAhead.isLoading, images, chapterIdOfImage, index]
  );

  const open = (segment: StorylineRailSegment<(typeof rail.line)[number]>) => {
    if (segment.kind === 'path') return jumpToChapter(segment.chapter.chapterId);
    const before = rail.line[rail.line.indexOf(segment.chapter) - 1];
    continueTo(segment.chapter, { track: false, from: before?.chapterId, line: rail.line });
  };
  const openMap = () => setDrawerOpen(true);

  return (
    <nav
      aria-label="Chapters"
      className="mx-auto flex h-4 w-full max-w-[420px] items-center gap-1.5"
      data-testid="storyline-rail"
    >
      {rail.clippedStart && <Ellipsis />}
      {rail.segments.map((segment) => {
        const { chapter, kind, depth, current, leaves, joins, ticks } = segment;
        const label = `Chapter ${depth + 1}: ${getStorylineChapterName(chapter)}`;
        return (
          <div
            key={chapter.chapterId}
            className="relative flex h-full min-w-0 items-center"
            // Same total width at every chapter: only the share the current one takes moves.
            style={{ flex: current ? Math.min(Math.max(ticks.length, 3), 8) : 1 }}
            data-testid="storyline-rail-segment"
            data-chapter-id={chapter.chapterId}
            data-kind={kind}
            data-current={current || undefined}
          >
            {joins && (
              <UnstyledButton
                onClick={openMap}
                aria-label={`Another path joins at chapter ${depth + 1}. Open the map`}
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
                disabled={!chapter.post}
                aria-label={kind === 'ahead' ? `${label} (canon ahead)` : label}
                className="flex size-full items-center"
              >
                <span
                  className={clsx(
                    'h-1 w-full rounded border border-solid border-gray-4 shadow-2xl',
                    !chapter.post ? 'bg-gray-6' : 'bg-white',
                    kind === 'ahead' ? 'opacity-30' : 'dark:opacity-60'
                  )}
                />
              </UnstyledButton>
            )}
            {leaves && (
              <UnstyledButton
                onClick={openMap}
                aria-label={`Another path leaves after chapter ${depth + 1}. Open the map`}
                className={clsx(STUB, '-right-1 origin-bottom rotate-45')}
                data-testid="storyline-rail-leave"
              />
            )}
          </div>
        );
      })}
      {rail.clippedEnd && <Ellipsis />}
    </nav>
  );
}

function Ellipsis() {
  return (
    <span aria-hidden className="shrink-0 text-xs leading-none text-white/70">
      …
    </span>
  );
}
