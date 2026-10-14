import { Badge, Drawer, Text, UnstyledButton } from '@mantine/core';
import clsx from 'clsx';
import { useMemo } from 'react';
import type { ActiveStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import type { StorylineChild } from '~/components/Storyline/storyline.queries';
import {
  STORYLINE_DRAWER_FORK_STOPS,
  useStorylineForkShares,
  useStorylinePathChildren,
} from '~/components/Storyline/storyline.queries';
import { getStorylineTombstoneLabel } from '~/components/Storyline/storyline-mode.utils';
import { useIsMobile } from '~/hooks/useIsMobile';

/**
 * "Where am I": the path as a subway line, with the other branches leaving each stop. Any
 * chapter on the line can be jumped to; a branch off it is read by continuing into it.
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
  const childrenByChapterId = useStorylinePathChildren(forkStopIds, { enabled: drawerOpen });
  const endChapterId = path.chapters[path.chapters.length - 1]?.chapterId;
  const { data: endShares } = useStorylineForkShares(drawerOpen ? endChapterId : undefined);

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
          className="absolute bottom-3 left-[9px] top-3 w-0.5 bg-blue-5 dark:bg-blue-4"
        />
        {path.chapters.map((chapter, i) => {
          const nextOnPath = path.chapters[i + 1]?.chapterId;
          const branches = (childrenByChapterId.get(chapter.chapterId) ?? []).filter(
            (child) => child.chapterId !== nextOnPath
          );
          const isEnd = i === path.chapters.length - 1;
          const isCurrent = chapter.chapterId === currentChapterId;
          return (
            <li key={chapter.chapterId} className="relative">
              <UnstyledButton
                onClick={() => jumpToChapter(chapter.chapterId)}
                disabled={!chapter.post}
                aria-current={isCurrent ? 'step' : undefined}
                className={clsx(
                  'relative flex w-full items-center gap-2 rounded py-2 pl-7 pr-2 text-left',
                  isCurrent && 'bg-blue-0 font-bold dark:bg-dark-5',
                  !chapter.post && 'cursor-default'
                )}
              >
                <span
                  aria-hidden
                  className={clsx(
                    'absolute left-1 top-1/2 size-3 -translate-y-1/2 rounded-full border-2 border-solid border-white dark:border-dark-7',
                    chapter.post ? 'bg-blue-5' : 'bg-gray-5',
                    isCurrent && 'ring-4 ring-blue-5/30'
                  )}
                />
                <Text size="sm" c={chapter.post ? undefined : 'dimmed'} lineClamp={2}>
                  {chapter.depth + 1}.{' '}
                  {chapter.post
                    ? chapter.post.title || 'Untitled chapter'
                    : getStorylineTombstoneLabel(chapter.tombstone)}
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
                      onClick={() => continueTo(child)}
                    />
                  ))}
                  {isEnd && endShares && !endShares.enough && (
                    <li>
                      <Text size="xs" c="dimmed" data-testid="storyline-shares-pending">
                        Not enough readers yet ({endShares.total} of {endShares.minChoices} choices)
                      </Text>
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
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
          {child.post
            ? child.post.title || 'Untitled chapter'
            : getStorylineTombstoneLabel(child.tombstone)}
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
