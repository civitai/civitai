import { Badge, Drawer, Loader, Text, UnstyledButton } from '@mantine/core';
import clsx from 'clsx';
import { useMemo } from 'react';
import type { ActiveStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import type { StorylineChild } from '~/components/Storyline/storyline.queries';
import {
  STORYLINE_DRAWER_FORK_STOPS,
  useStorylineCanonAhead,
  useStorylineForkShares,
  useStorylinePathChildren,
} from '~/components/Storyline/storyline.queries';
import {
  buildSubwayStops,
  getStorylineChapterName,
} from '~/components/Storyline/storyline-mode.utils';
import { useIsMobile } from '~/hooks/useIsMobile';

/**
 * "Where am I": the story as a subway line, the path being read then the canon chapters after
 * it, with the other branches leaving each stop. Any stop can be jumped to; a branch is read by
 * continuing into it.
 */
export function StorylineDrawer({
  storyline,
  currentChapterId,
}: {
  storyline: ActiveStorylineMode;
  currentChapterId: number | undefined;
}) {
  const isMobile = useIsMobile({ type: 'media' });
  const { path, drawerOpen, setDrawerOpen, jumpToChapter, continueTo } = storyline;
  const forkStopIds = useMemo(
    () => path.chapters.slice(-STORYLINE_DRAWER_FORK_STOPS).map((c) => c.chapterId),
    [path.chapters]
  );
  const pathChildren = useStorylinePathChildren(forkStopIds, { enabled: drawerOpen });
  const endChapterId = path.chapters[path.chapters.length - 1]?.chapterId;
  const canonAhead = useStorylineCanonAhead(endChapterId, { enabled: drawerOpen });
  const { data: endShares } = useStorylineForkShares(drawerOpen ? endChapterId : undefined);
  const stops = useMemo(
    () =>
      buildSubwayStops(
        path.chapters,
        canonAhead.ahead,
        new Map([...canonAhead.childrenByChapterId, ...pathChildren])
      ),
    [path.chapters, canonAhead, pathChildren]
  );

  return (
    <Drawer
      opened={drawerOpen}
      onClose={() => setDrawerOpen(false)}
      position="right"
      size={isMobile ? '100%' : 'md'}
      title={
        <div>
          <Text fw={700}>{path.storyline.title}</Text>
          <Text size="xs" c="dimmed">
            Tap a chapter to jump to it
          </Text>
        </div>
      }
      zIndex={400}
    >
      <ol className="relative m-0 list-none p-0" data-testid="storyline-subway">
        <span
          aria-hidden
          className="absolute inset-y-3 left-[9px] w-0.5 bg-blue-5 dark:bg-blue-4"
        />
        {stops.map(({ chapter, kind, branches }) => {
          const isEnd = chapter.chapterId === endChapterId;
          const isCurrent = chapter.chapterId === currentChapterId;
          const open = () =>
            kind === 'path'
              ? jumpToChapter(chapter.chapterId)
              : continueTo(chapter, { track: false });
          return (
            <li key={chapter.chapterId} className="relative" data-stop={kind}>
              <UnstyledButton
                onClick={open}
                disabled={kind === 'path' && !chapter.post}
                aria-current={isCurrent ? 'step' : undefined}
                className={clsx(
                  'relative flex w-full items-center gap-2 rounded py-2 pl-7 pr-2 text-left',
                  isCurrent && 'bg-blue-0 font-bold dark:bg-dark-5'
                )}
                data-testid="storyline-stop"
                data-chapter-id={chapter.chapterId}
              >
                <span
                  aria-hidden
                  className={clsx(
                    'absolute left-1 top-1/2 size-3 -translate-y-1/2 rounded-full border-2 border-solid border-white dark:border-dark-7',
                    !chapter.post ? 'bg-gray-5' : kind === 'ahead' ? 'bg-blue-2' : 'bg-blue-5',
                    isCurrent && 'ring-4 ring-blue-5/30'
                  )}
                />
                <Text size="sm" c={chapter.post ? undefined : 'dimmed'} lineClamp={2}>
                  {chapter.depth + 1}. {getStorylineChapterName(chapter)}
                </Text>
                {chapter.post?.username && (
                  <Text size="xs" c="dimmed" className="ml-auto shrink-0">
                    {chapter.post.username}
                  </Text>
                )}
              </UnstyledButton>
              {branches.length > 0 && (
                <ul className="m-0 list-none py-0 pl-9 pr-0">
                  {branches.map((child) => (
                    <BranchRow
                      key={child.chapterId}
                      child={child}
                      share={
                        isEnd && endShares?.enough
                          ? endShares.shares[child.chapterId] ?? 0
                          : undefined
                      }
                      onClick={() => continueTo(child, { from: chapter.chapterId })}
                    />
                  ))}
                </ul>
              )}
              {isEnd && endShares && !endShares.enough && (
                <Text size="xs" c="dimmed" pl={36} data-testid="storyline-shares-pending">
                  Not enough readers yet ({endShares.total} of {endShares.minChoices} choices)
                </Text>
              )}
            </li>
          );
        })}
      </ol>
      {canonAhead.isLoading && (
        <div className="flex items-center gap-2 py-2 pl-7">
          <Loader size="xs" />
          <Text size="xs" c="dimmed">
            Finding the rest of the story
          </Text>
        </div>
      )}
    </Drawer>
  );
}

function BranchRow({
  child,
  share,
  onClick,
}: {
  child: StorylineChild;
  share: number | undefined;
  onClick: () => void;
}) {
  return (
    <li>
      <UnstyledButton
        onClick={onClick}
        className="flex w-full items-center gap-2 rounded border border-dashed border-violet-5 px-2 py-1 text-left"
        data-testid="storyline-branch"
        data-chapter-id={child.chapterId}
        data-tombstone={child.tombstone ?? undefined}
      >
        <Text size="xs" c="dimmed" lineClamp={1} className="flex-1">
          {getStorylineChapterName(child, { withAuthor: true })}
        </Text>
        {child.rank === 'canon' && (
          <Badge size="xs" variant="outline">
            Canon
          </Badge>
        )}
        {share != null && (
          <Badge size="xs" variant="light">
            {Math.round(share * 100)}%
          </Badge>
        )}
      </UnstyledButton>
    </li>
  );
}
