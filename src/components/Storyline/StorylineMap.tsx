import {
  Badge,
  Button,
  CloseButton,
  Drawer,
  Loader,
  Popover,
  Progress,
  Text,
  UnstyledButton,
} from '@mantine/core';
import {
  IconArrowRight,
  IconBook2,
  IconCrown,
  IconGitFork,
  IconGitMerge,
  IconRosetteDiscountCheck,
  IconRoute,
} from '@tabler/icons-react';
import clsx from 'clsx';
import Router from 'next/router';
import type { MouseEvent } from 'react';
import { useId, useMemo } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { StorylineChapterImage } from '~/components/Storyline/StorylineChapterImage';
import type { StorylineCoverImage } from '~/components/Storyline/StorylineChapterImage';
import type { ActiveStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import { StorylineModeChip } from '~/components/Storyline/StorylinePill';
import type { StorylineChild } from '~/components/Storyline/storyline.queries';
import {
  STORYLINE_DRAWER_FORK_STOPS,
  useStorylineCanonAhead,
  useStorylineForkShares,
  useStorylinePathChildren,
} from '~/components/Storyline/storyline.queries';
import { isModifiedClick } from '~/components/Storyline/storyline-read-link';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import type { SubwayStop } from '~/components/Storyline/storyline-mode.utils';
import {
  buildSubwayStops,
  getForkShare,
  getStorylineChapterName,
  storylinePositionLabel,
} from '~/components/Storyline/storyline-mode.utils';
import { useIsMobile } from '~/hooks/useIsMobile';

type WithCover = { firstImage?: StorylineCoverImage | null };
const coverOf = (chapter: unknown) => (chapter as WithCover).firstImage;

/**
 * The chip in the stage toolbar and the map that drops from it. Neither layout dims the stage: the
 * image and its arrows stay live while the map is open.
 */
export function StorylineMapControl({
  storyline,
  currentChapterId,
  depth,
}: {
  storyline: ActiveStorylineMode;
  currentChapterId: number | undefined;
  depth: number;
}) {
  const isMobile = useIsMobile({ type: 'media' });
  const { drawerOpen, setDrawerOpen, path } = storyline;
  const titleId = useId();
  const chip = (
    <StorylineModeChip
      title={path.storyline.title}
      depth={depth}
      mapOpen={drawerOpen}
      onToggleMap={() => setDrawerOpen(!drawerOpen)}
    />
  );

  if (isMobile)
    return (
      <>
        {chip}
        {/* The parts, not <Drawer>: no overlay, and a name on the dialog itself. <Drawer> puts
            aria-labelledby on its root, and its content only takes a Drawer.Title's id. */}
        <Drawer.Root
          opened={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          position="bottom"
          size="72%"
          lockScroll={false}
          zIndex={400}
          radius="lg"
          padding={0}
        >
          <Drawer.Content
            aria-label={`Storyline map: ${path.storyline.title}`}
            className="shadow-[0_-12px_32px_rgba(0,0,0,.45)]"
          >
            <Drawer.Body className="flex h-full flex-col">
              <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-gray-4" />
              <StorylineMap
                storyline={storyline}
                currentChapterId={currentChapterId}
                titleId={titleId}
              />
            </Drawer.Body>
          </Drawer.Content>
        </Drawer.Root>
      </>
    );

  return (
    <Popover
      opened={drawerOpen}
      onChange={setDrawerOpen}
      position="bottom-start"
      withArrow
      width={380}
      // The theme defaults Popover to inline; the stage clips, so the sheet needs the portal.
      withinPortal
      trapFocus
      returnFocus
      closeOnEscape
      zIndex={300}
      shadow="xl"
    >
      <Popover.Target>{chip}</Popover.Target>
      <Popover.Dropdown
        p={0}
        aria-labelledby={titleId}
        className="flex max-h-[calc(100dvh-136px)] flex-col overflow-hidden"
        data-testid="storyline-map-sheet"
      >
        <StorylineMap storyline={storyline} currentChapterId={currentChapterId} titleId={titleId} />
      </Popover.Dropdown>
    </Popover>
  );
}

function StorylineMap({
  storyline,
  currentChapterId,
  titleId,
}: {
  storyline: ActiveStorylineMode;
  currentChapterId: number | undefined;
  titleId: string;
}) {
  const { path, drawerOpen, setDrawerOpen, jumpToChapter, continueTo, leave } = storyline;
  const dialog = useDialogContext();
  const forkStopIds = useMemo(
    () => path.chapters.slice(-STORYLINE_DRAWER_FORK_STOPS).map((c) => c.chapterId),
    [path.chapters]
  );
  const pathChildren = useStorylinePathChildren(forkStopIds, { enabled: drawerOpen });
  const end = path.chapters[path.chapters.length - 1];
  const endChapterId = end?.chapterId;
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

  const line = useMemo(() => stops.map((stop) => stop.chapter), [stops]);
  const currentIndex = stops.findIndex((s) => s.chapter.chapterId === currentChapterId);
  const current = stops[currentIndex];
  const next = currentIndex >= 0 ? stops[currentIndex + 1] : undefined;
  // The line's length once it is known: the path then the chapters ahead of its end, counted from
  // chapter 1 like a chapter's number, since a long path is read from a window that starts deeper.
  const length = canonAhead.isLoading ? undefined : (path.chapters[0]?.depth ?? 0) + stops.length;
  const open = (stop: SubwayStop<StorylineChild>) => {
    if (stop.kind === 'path') return jumpToChapter(stop.chapter.chapterId);
    const before = line[line.indexOf(stop.chapter) - 1];
    continueTo(stop.chapter, { track: false, from: before?.chapterId, line });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-2.5 border-b border-solid border-gray-3 p-3.5 pb-2.5 dark:border-dark-4">
        <StorylineChapterImage
          image={coverOf(path.chapters[0])}
          hidden={false}
          explain={false}
          ratingBadge={false}
          emptyIcon="photo"
          className="size-10 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <Text
            component="div"
            className="flex items-center gap-1.5 text-[11px] font-extrabold tracking-wide text-[var(--mantine-color-violet-6)] dark:text-[var(--mantine-color-violet-3)]"
          >
            <IconRoute size={13} />
            STORYLINE
          </Text>
          <Text
            id={titleId}
            fw={800}
            className="truncate leading-tight"
            data-testid="storyline-map-title"
          >
            {path.storyline.title}
          </Text>
          {current && (
            <Text size="xs" c="dimmed" data-testid="storyline-map-position">
              {storylinePositionLabel({
                number: current.chapter.depth + 1,
                length,
                path: path.chapters,
              })}
            </Text>
          )}
          {current && length ? (
            <Progress
              value={((current.chapter.depth + 1) / length) * 100}
              size={4}
              color="violet"
              mt={8}
              aria-hidden
            />
          ) : null}
        </div>
        <CloseButton
          size="sm"
          onClick={() => setDrawerOpen(false)}
          aria-label="Close the map"
          data-testid="storyline-map-close"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2.5">
        <ol className="relative m-0 list-none p-0" data-testid="storyline-subway">
          <span
            aria-hidden
            className="absolute inset-y-6 left-[15px] w-0.5 bg-blue-5/50 dark:bg-blue-4/50"
          />
          {stops.map((stop) => {
            const { chapter, kind, branches, joins } = stop;
            const isEnd = chapter.chapterId === endChapterId;
            const isCurrent = chapter.chapterId === currentChapterId;
            return (
              <li key={chapter.chapterId} className="relative" data-stop={kind}>
                <UnstyledButton
                  onClick={() => open(stop)}
                  disabled={kind === 'path' && !chapter.post}
                  aria-current={isCurrent ? 'step' : undefined}
                  className={clsx(
                    'relative flex w-full items-center gap-2.5 rounded-lg py-1.5 pl-[34px] pr-2 text-left',
                    isCurrent && 'bg-blue-0 dark:bg-[rgba(34,139,230,.15)]',
                    kind === 'ahead' && 'opacity-90'
                  )}
                  data-testid="storyline-stop"
                  data-chapter-id={chapter.chapterId}
                >
                  <span
                    aria-hidden
                    className={clsx(
                      'absolute left-[9px] top-1/2 size-3.5 -translate-y-1/2 rounded-full border-2 border-solid',
                      kind === 'ahead'
                        ? 'border-blue-5 bg-white dark:bg-dark-6'
                        : chapter.post
                        ? 'border-white bg-blue-5 dark:border-dark-6'
                        : 'border-white bg-gray-5 dark:border-dark-6',
                      isCurrent && 'ring-4 ring-blue-5/30'
                    )}
                  />
                  <StorylineChapterImage
                    image={coverOf(chapter)}
                    hidden={!chapter.post}
                    explain={false}
                    ratingBadge={false}
                    emptyIcon="photo"
                    className="aspect-[3/4] w-12 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <Text size="xs" fw={700} c="dimmed">
                      CH {chapter.depth + 1}
                      {isCurrent ? ' · YOU ARE HERE' : kind === 'ahead' ? ' · CANON AHEAD' : ''}
                    </Text>
                    <Text
                      size="sm"
                      fw={isCurrent ? 800 : 600}
                      c={chapter.post ? undefined : 'dimmed'}
                      lineClamp={2}
                      className="leading-tight"
                    >
                      {getStorylineChapterName(chapter)}
                    </Text>
                    {chapter.post?.username && (
                      <Text size="xs" c="dimmed">
                        {chapter.post.username}
                      </Text>
                    )}
                  </div>
                </UnstyledButton>
                {joins.map((join) => (
                  <UnstyledButton
                    key={join.chapterId}
                    // A fresh route to the other branch's chapter: the reader is leaving this line.
                    onClick={() => continueTo(join, { track: false, line: [] })}
                    disabled={!join.post}
                    className="ml-[34px] mt-1 flex items-center gap-1 rounded text-left text-xs font-semibold text-[var(--mantine-color-violet-7)] dark:text-[var(--mantine-color-violet-3)]"
                    data-testid="storyline-join"
                    data-chapter-id={join.chapterId}
                  >
                    <IconGitMerge size={13} className="shrink-0" />
                    {join.post
                      ? `Another branch joins here, after ${getStorylineChapterName(join)}`
                      : 'Another branch joins here'}
                  </UnstyledButton>
                ))}
                {branches.length > 0 && (
                  <div className="pl-[34px]">
                    <Text
                      component="div"
                      size="xs"
                      fw={700}
                      c="dimmed"
                      className="mt-1 flex items-center gap-1"
                    >
                      <IconGitFork size={13} />
                      Other paths after chapter {chapter.depth + 1}
                    </Text>
                    <ul className="m-0 list-none p-0">
                      {branches.map((child) => (
                        <BranchRow
                          key={child.chapterId}
                          child={child}
                          share={
                            isEnd ? getForkShare(endShares, child.chapterId)?.percent : undefined
                          }
                          onClick={() => continueTo(child, { from: chapter.chapterId, line })}
                        />
                      ))}
                    </ul>
                  </div>
                )}
                {isEnd && endShares?.total === 0 && branches.length > 0 && (
                  <Text size="xs" c="dimmed" pl={34} data-testid="storyline-shares-pending">
                    Be the first to choose
                  </Text>
                )}
              </li>
            );
          })}
        </ol>
        {canonAhead.isLoading && (
          <div className="flex items-center gap-2 py-2 pl-[34px]">
            <Loader size="xs" />
            <Text size="xs" c="dimmed">
              Finding the rest of the story
            </Text>
          </div>
        )}
      </div>

      <div className="flex gap-2 border-t border-solid border-gray-3 p-2.5 px-3.5 dark:border-dark-4">
        {next && (
          <Button
            size="sm"
            className="flex-1"
            rightSection={<IconArrowRight size={16} />}
            disabled={next.kind === 'path' && !next.chapter.post}
            onClick={() => open(next)}
            data-testid="storyline-map-read-next"
          >
            Read chapter {next.chapter.depth + 1}
          </Button>
        )}
        <Button
          size="sm"
          variant="default"
          component={Link}
          href={storylineUrl(path.storyline.id)}
          onClick={(e: MouseEvent<HTMLElement>) => {
            // Over its own story page, the reader is a dialog: close it rather than stack the page.
            if (isModifiedClick(e)) return;
            if (Router.asPath.split('?')[0] !== storylineUrl(path.storyline.id)) return;
            e.preventDefault();
            dialog.onClose();
          }}
          leftSection={<IconBook2 size={16} />}
          className={clsx(!next && 'flex-1')}
          data-testid="storyline-map-story-page"
        >
          Story page
        </Button>
      </div>
      <Button
        variant="subtle"
        color="gray"
        size="compact-sm"
        fullWidth
        radius={0}
        className="mb-2"
        onClick={leave}
        data-testid="storyline-leave"
      >
        Leave the storyline · browse this post&apos;s images
      </Button>
    </div>
  );
}

function BranchRow({
  child,
  share,
  onClick,
}: {
  child: StorylineChild;
  /** Percent of readers, shown only at the end of the path. */
  share: number | undefined;
  onClick: () => void;
}) {
  return (
    <li className="my-1">
      <UnstyledButton
        onClick={onClick}
        className="flex w-full items-center gap-2 rounded-lg border border-dashed border-[var(--mantine-color-violet-5)] px-2 py-1.5 text-left"
        data-testid="storyline-branch"
        data-chapter-id={child.chapterId}
        data-tombstone={child.tombstone ?? undefined}
      >
        <StorylineChapterImage
          image={coverOf(child)}
          hidden={!child.post}
          explain={false}
          ratingBadge={false}
          emptyIcon="photo"
          className="aspect-[3/4] w-8 shrink-0"
        />
        <Text
          size="xs"
          fw={600}
          c={child.post ? undefined : 'dimmed'}
          lineClamp={2}
          className="flex-1"
          data-testid="storyline-branch-name"
        >
          {getStorylineChapterName(child, { withAuthor: true })}
        </Text>
        {child.rank !== 'community' && (
          <Badge
            size="xs"
            radius="xl"
            variant="light"
            color={child.rank === 'canon' ? 'blue' : 'teal'}
            leftSection={
              child.rank === 'canon' ? (
                <IconCrown size={10} />
              ) : (
                <IconRosetteDiscountCheck size={10} />
              )
            }
          >
            {child.rank === 'canon' ? 'Canon' : 'Endorsed'}
          </Badge>
        )}
        {share != null && (
          <Text size="xs" fw={800} className="w-8 text-right" data-testid="storyline-branch-share">
            {share}%
          </Text>
        )}
      </UnstyledButton>
    </li>
  );
}
