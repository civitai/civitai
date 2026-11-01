import {
  Anchor,
  Badge,
  Button,
  CloseButton,
  Kbd,
  Progress,
  Skeleton,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { modals, openConfirmModal } from '@mantine/modals';
import { useRouter } from 'next/router';
import {
  IconArrowRight,
  IconCrown,
  IconGitFork,
  IconLock,
  IconPencil,
  IconRosetteDiscountCheck,
  IconRoute,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { StorylineEarlyAccessModal } from '~/components/Storyline/StorylineEarlyAccessModal';
import { StorylineChapterImage } from '~/components/Storyline/StorylineChapterImage';
import { openStorylineContinueModal } from '~/components/Storyline/continue/openStorylineContinueModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { StorylineChild } from '~/components/Storyline/storyline.queries';
import { useSetStorylineMainPath } from '~/components/Storyline/storyline.data';
import {
  useStorylineCanonAhead,
  useStorylineChildren,
  useStorylineContinueTerms,
  useStorylineForkShares,
  useStorylineTracking,
} from '~/components/Storyline/storyline.queries';
import type { StorylineShares } from '~/components/Storyline/storyline-mode.utils';
import {
  getForkShare,
  getStorylineChapterName,
  getStorylineTombstoneLabel,
} from '~/components/Storyline/storyline-mode.utils';
import { storylineContinueUrl } from '~/components/Storyline/storyline-routes';
import { storylinePriceLabel } from '~/components/Storyline/storyline-ui';
import { useHasCoarsePointer, useIsMobile } from '~/hooks/useIsMobile';
import { STORYLINE_PATH_LIMIT } from '~/shared/utils/storyline';

export function openStorylineEarlyAccess({
  chapterId,
  storylineId,
}: {
  chapterId: number;
  storylineId: number;
}) {
  dialogStore.trigger({
    id: 'storyline-early-access',
    component: StorylineEarlyAccessModal,
    props: { chapterId, storylineId },
  });
}

/**
 * The fork point at the end of a chapter. The first child is the main path and gets the lead card;
 * the order is the server's (canon, endorsed collaborators, then by readers).
 */
export function StorylineEndOfChapter({
  chapterId,
  storylineId,
  chapterDepth,
  chapterTombstone,
  parentPostId,
  isOwner = false,
  onMain = true,
  layout = 'overlay',
  onContinue,
  onClose,
}: {
  chapterId: number;
  storylineId: number;
  /** Depth of the chapter that ends here (chapter 1 is depth 0); its children are numbered from it. */
  chapterDepth: number;
  chapterTombstone?: Parameters<typeof getStorylineTombstoneLabel>[0] | null;
  onContinue: (child: StorylineChild) => void;
  onClose?: () => void;
  /** The post of the chapter that ends here; absent when it is a tombstone. */
  parentPostId?: number;
  /** The reader made this storyline: they add chapters directly, never by continuing it. */
  isOwner?: boolean;
  /** The chapter is on the owner's main route; otherwise the reader is on a branch. */
  onMain?: boolean;
  layout?: 'overlay' | 'section';
}) {
  const currentUser = useCurrentUser();
  const { data: children, isLoading } = useStorylineChildren(chapterId);
  const { data: forkShares } = useStorylineForkShares(chapterId);
  const tracking = useStorylineTracking();
  // The owner is never "closed out" of their own storyline, so their terms are not read.
  const terms = useStorylineContinueTerms(isOwner ? undefined : parentPostId);
  const canWrite = !!parentPostId && (isOwner || !!terms?.open);
  const setMainPath = useSetStorylineMainPath();
  // The server refuses a removed chapter. A moderator is not shown one as removed, so is offered it
  // and sees the refusal. A deleted chapter has no post left to lead to.
  const makeMainFor = (child: StorylineChild) =>
    (isOwner || currentUser?.isModerator) &&
    child.rank !== 'canon' &&
    child.tombstone !== 'removed' &&
    child.tombstone !== 'deleted'
      ? () =>
          openConfirmModal({
            title: 'Make this the main path',
            children: (
              <Text size="sm">
                Make <strong>{getStorylineChapterName(child)}</strong> the main path after chapter{' '}
                {chapterDepth + 1}? Readers are sent this way first. The current main path stays, as
                one of the other paths.
              </Text>
            ),
            labels: { confirm: 'Make main path', cancel: 'Cancel' },
            onConfirm: () =>
              setMainPath.mutate({ chapterId: child.chapterId, parentChapterId: chapterId }),
          })
      : undefined;

  // Numbered from this chapter, not by their own depth, which a rejoined chapter takes from another branch.
  const [main, ...others] = (children ?? []).map((child) => ({
    ...child,
    depth: chapterDepth + 1,
  })) as StorylineChild[];
  const ended = !children?.length && !isLoading;

  // Mid-story: the chapter already has a main-path chapter after it, so writing after it starts a
  // branch. The way on is to the end of the path instead, named so the reader sees where they land.
  const midStory = main?.rank === 'canon';
  const canonAhead = useStorylineCanonAhead(midStory ? chapterId : undefined, {
    enabled: midStory,
    forks: false,
  });
  const pathEnd = canonAhead.ahead.at(-1);
  // Not offered when the end is hidden from this reader, or past the read's cap (its last chapter
  // would not be the end): continuing an earlier one would make a branch.
  const endTarget =
    midStory && pathEnd?.post && canonAhead.ahead.length < STORYLINE_PATH_LIMIT - 1
      ? { chapterId: pathEnd.chapterId, depth: pathEnd.depth, post: pathEnd.post }
      : undefined;
  // Nothing to write until the ways on are read (and, mid-story, the end): before then an action
  // would continue this chapter, which is the accidental branch. A failed read offers none.
  const writeReady = children !== undefined && (!midStory || canonAhead.isSuccess);
  // Priced against the chapter the continuation is placed on: the end, not the one on screen.
  const endTerms = useStorylineContinueTerms(isOwner ? undefined : endTarget?.post.id);
  const router = useRouter();
  const confirmBranch = (postId: number) =>
    openConfirmModal({
      title: 'Start a branch?',
      children: (
        <div className="flex flex-col gap-2">
          <Text size="sm">
            Start a side path after chapter {chapterDepth + 1}? Readers will see it as one of the
            other paths.
          </Text>
          <Anchor
            component="button"
            type="button"
            size="sm"
            className="self-start"
            onClick={() => {
              modals.closeAll();
              openStorylineContinueModal(
                isOwner
                  ? { parentPostId: postId, parentChapterId: chapterId, branch: true }
                  : { parentPostId: postId, branch: true }
              );
            }}
            data-testid="storyline-branch-use-post"
          >
            or use a post you already made
          </Anchor>
        </div>
      ),
      labels: { confirm: 'Write a branch', cancel: 'Cancel' },
      onConfirm: () => {
        tracking.trackCreateClick({ chapterId });
        router.push(
          storylineContinueUrl({ parentChapterId: chapterId, chapterNumber: chapterDepth + 2 })
        );
      },
    });

  // With one way on, → takes it. Desktop only: the reader's overlay, never a narrow stage or a touch screen.
  const stageIsNarrow = useIsMobile({ breakpoint: 'md', type: 'media' });
  const touchScreen = useHasCoarsePointer();
  const arrowContinues =
    layout === 'overlay' &&
    !stageIsNarrow &&
    !touchScreen &&
    !isLoading &&
    others.length === 0 &&
    !!main?.post &&
    !main.tombstone;
  useEffect(() => {
    if (!arrowContinues || !main) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowRight' || event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      )
        return;
      // The window's capture phase comes before the carousel's own arrow handler, which would
      // otherwise reopen this card on the chapter we are leaving.
      event.preventDefault();
      event.stopPropagation();
      onContinue(main);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [arrowContinues, main, onContinue]);

  return (
    <div
      className={
        layout === 'overlay'
          ? 'absolute inset-0 z-20 overflow-y-auto bg-white p-4 @md:p-7 dark:bg-dark-7'
          : 'rounded-xl border border-solid border-gray-3 bg-white p-4 @md:p-6 dark:border-dark-4 dark:bg-dark-7'
      }
      data-testid="storyline-end-of-chapter"
      data-layout={layout}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Text
              className="flex items-center gap-1.5 text-[13px] font-bold text-[var(--mantine-color-violet-7)] dark:text-[var(--mantine-color-violet-3)]"
              component="div"
            >
              <IconRoute size={15} className="shrink-0" />
              <span className="truncate">End of chapter {chapterDepth + 1}</span>
            </Text>
            <Title order={2} className="mt-1 text-2xl font-extrabold @md:text-[30px]">
              {ended ? 'The story stops here, for now' : 'What happens next?'}
            </Title>
            {chapterTombstone && (
              <Text size="sm" c="dimmed" mt={4}>
                {getStorylineTombstoneLabel(chapterTombstone)}
              </Text>
            )}
          </div>
          {onClose && <CloseButton onClick={onClose} aria-label="Back to the chapter" />}
        </div>

        {isLoading ? (
          <LeadSkeleton />
        ) : (
          <>
            {main && (
              <LeadFork
                child={main}
                shares={forkShares}
                onContinue={onContinue}
                hotkey={arrowContinues}
                onMakeMain={makeMainFor(main)}
                makingMain={setMainPath.isPending}
              />
            )}
            {others.length > 0 && (
              <>
                <Text component="div" className="flex items-center gap-1.5 font-bold">
                  <IconGitFork size={16} />
                  Other paths
                  <Text span c="dimmed" fw={600}>
                    {others.length}
                  </Text>
                </Text>
                <div className="-mx-4 flex gap-2.5 overflow-x-auto px-4 pb-1 @md:mx-0 @md:grid @md:grid-cols-2 @md:gap-3 @md:overflow-visible @md:p-0">
                  {others.map((child) => (
                    <OtherFork
                      key={child.chapterId}
                      child={child}
                      shares={forkShares}
                      onContinue={onContinue}
                      onMakeMain={makeMainFor(child)}
                      makingMain={setMainPath.isPending}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        <div
          className="flex flex-col gap-3 rounded-xl border-[1.5px] border-dashed border-[var(--mantine-color-violet-5)] bg-[var(--mantine-color-violet-0)] px-4 py-3.5 dark:bg-[rgba(95,61,196,0.15)]"
          data-testid="storyline-create-block"
        >
          <div>
            <Text fw={700}>Write what happens next</Text>
            <Text size="sm" c="dimmed">
              {isOwner
                ? 'Add a chapter of your own. It joins the story as soon as you publish it.'
                : 'Add a chapter of your own. The creator reviews it before it joins the story.'}
            </Text>
          </div>
          <div className="flex flex-col gap-3 @md:flex-row @md:items-start @md:justify-between">
            <div className="flex flex-col items-stretch gap-2 @md:items-start">
              {!writeReady ? null : midStory ? (
                <>
                  {endTarget && (isOwner || endTerms?.open) && (
                    <div className="flex flex-col items-stretch gap-1 @md:items-start">
                      <Button
                        component={Link}
                        href={storylineContinueUrl({
                          parentChapterId: endTarget.chapterId,
                          chapterNumber: endTarget.depth + 2,
                        })}
                        color="violet"
                        leftSection={<IconPencil size={16} />}
                        onClick={() =>
                          tracking.trackCreateClick({ chapterId: endTarget.chapterId })
                        }
                        data-testid="storyline-continue-path-end"
                      >
                        {onMain ? 'Continue the main path' : 'Continue this path'}
                      </Button>
                      <Text size="xs" c="dimmed" data-testid="storyline-path-end-name">
                        after Chapter {endTarget.depth + 1}
                        {endTarget.post.title ? ` · ${endTarget.post.title}` : ''}
                        {!isOwner && endTerms
                          ? endTerms.price > 0
                            ? ` · ${storylinePriceLabel(endTerms.price)} when you publish`
                            : ' · Free to submit'
                          : ''}
                      </Text>
                      {isOwner ? (
                        <Anchor
                          component="button"
                          type="button"
                          size="sm"
                          onClick={() =>
                            openStorylineContinueModal({
                              parentPostId: endTarget.post.id,
                              parentChapterId: endTarget.chapterId,
                            })
                          }
                          data-testid="storyline-add-own-chapter"
                        >
                          or use a post you already made
                        </Anchor>
                      ) : (
                        <StorylineContinueWithPost parentPostId={endTarget.post.id} />
                      )}
                    </div>
                  )}
                  {canWrite && parentPostId && (
                    <div className="flex flex-col gap-0.5">
                      <Anchor
                        component="button"
                        type="button"
                        size="sm"
                        className="flex items-center gap-1 self-start"
                        onClick={() => confirmBranch(parentPostId)}
                        data-testid="storyline-start-branch"
                      >
                        <IconGitFork size={14} /> Start a branch from here
                      </Anchor>
                      <Text size="xs" c="dimmed">
                        A side path after this chapter. The {onMain ? 'main path' : 'path'} still
                        goes on to {main ? getStorylineChapterName(main) : 'the next chapter'}.
                      </Text>
                    </div>
                  )}
                </>
              ) : (
                <>
                  {canWrite && (
                    <Button
                      component={Link}
                      href={storylineContinueUrl({
                        parentChapterId: chapterId,
                        chapterNumber: chapterDepth + 2,
                      })}
                      color="violet"
                      leftSection={<IconPencil size={16} />}
                      onClick={() => tracking.trackCreateClick({ chapterId })}
                      data-testid="storyline-write-next"
                    >
                      {onMain ? 'Write the next chapter' : 'Continue this path'}
                    </Button>
                  )}
                  {canWrite && !isOwner && terms && (
                    <Text size="xs" c="dimmed" data-testid="storyline-write-next-price">
                      {terms.price > 0
                        ? `${storylinePriceLabel(terms.price)} when you publish`
                        : 'Free to submit'}
                    </Text>
                  )}
                  {parentPostId &&
                    (isOwner ? (
                      <Anchor
                        component="button"
                        type="button"
                        size="sm"
                        onClick={() =>
                          openStorylineContinueModal({ parentPostId, parentChapterId: chapterId })
                        }
                        data-testid="storyline-add-own-chapter"
                      >
                        or use a post you already made
                      </Anchor>
                    ) : (
                      <StorylineContinueWithPost parentPostId={parentPostId} />
                    ))}
                </>
              )}
              {parentPostId && (isOwner || currentUser?.isModerator) && (
                <Anchor
                  component="button"
                  type="button"
                  size="sm"
                  onClick={() =>
                    openStorylineContinueModal({
                      parentPostId,
                      parentChapterId: chapterId,
                      mode: 'join',
                    })
                  }
                  data-testid="storyline-join-existing-chapter"
                >
                  Join an existing chapter
                </Anchor>
              )}
            </div>
            <Anchor
              component="button"
              type="button"
              size="xs"
              c="dimmed"
              className="self-center @md:self-start"
              onClick={() => openStorylineEarlyAccess({ chapterId, storylineId })}
              data-testid="storyline-early-access-link"
            >
              Story tool coming soon · get early access
            </Anchor>
          </div>
        </div>
      </div>
    </div>
  );
}

const cardClass =
  'relative rounded-xl border border-solid border-gray-3 bg-gray-0 shadow-sm dark:border-dark-4 dark:bg-dark-6';
const hiddenCardClass =
  'relative rounded-xl border-[1.5px] border-dashed border-gray-4 bg-transparent dark:border-dark-3';

function RankChip({ rank, onImage }: { rank: StorylineChild['rank']; onImage?: boolean }) {
  if (rank === 'community') return null;
  const canon = rank === 'canon';
  return (
    <Badge
      size="sm"
      radius="xl"
      variant="light"
      color={canon ? 'blue' : 'teal'}
      leftSection={canon ? <IconCrown size={12} /> : <IconRosetteDiscountCheck size={12} />}
      className={clsx(onImage && '!bg-black/55 !text-white backdrop-blur-sm')}
      data-testid="storyline-rank-chip"
    >
      {canon ? 'Canon' : 'Endorsed'}
    </Badge>
  );
}

function ShareBar({ percent, hidden }: { percent: number; hidden?: boolean }) {
  return (
    <Progress
      value={percent}
      size={6}
      radius="xl"
      color={hidden ? 'gray' : 'blue'}
      className="flex-1"
      aria-hidden
    />
  );
}

/** Above the card's own opener, so it is not read as opening the chapter. */
function MakeMainButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <Button
      variant="subtle"
      size="compact-xs"
      leftSection={<IconCrown size={12} />}
      onClick={onClick}
      loading={loading}
      className="relative z-10 self-start"
      data-testid="storyline-make-main"
    >
      Make main path
    </Button>
  );
}

/** Author, plus the chapter number unless an untitled chapter's name already is it. */
function byline(child: StorylineChild) {
  const author = child.post?.username ? `by ${child.post.username}` : '';
  if (child.post && !child.post.title) return author;
  return [`Chapter ${child.depth + 1}`, author].filter(Boolean).join(' ');
}

/** Fork-tagging attributes the end-to-end spec reads. */
function forkAttrs(child: StorylineChild) {
  return {
    'data-testid': 'storyline-fork',
    'data-rank': child.rank,
    'data-chapter-id': child.chapterId,
    'data-tombstone': child.tombstone ?? undefined,
  };
}

function LeadFork({
  child,
  shares,
  onContinue,
  hotkey,
  onMakeMain,
  makingMain = false,
}: {
  child: StorylineChild;
  shares: StorylineShares;
  onContinue: (child: StorylineChild) => void;
  /** → also takes this way, so the button says so. */
  hotkey?: boolean;
  /** Offered to the owner and moderators when this way is not already the main path. */
  onMakeMain?: () => void;
  makingMain?: boolean;
}) {
  const hidden = !child.post;
  const share = getForkShare(shares, child.chapterId);
  const name = getStorylineChapterName(child);

  return (
    <div
      {...forkAttrs(child)}
      className={clsx(
        'flex flex-col gap-4 p-3 @md:flex-row',
        hidden ? hiddenCardClass : clsx(cardClass, '!border-2 !border-blue-6')
      )}
    >
      <StorylineChapterImage
        image={child.firstImage}
        hidden={hidden}
        hiddenLabel={hidden ? name : undefined}
        className={clsx(
          'w-full @md:aspect-[4/5] @md:max-h-none @md:w-[210px] @md:flex-none',
          // On a phone the cover leaves room for the title, share and Read in the first screen.
          child.firstImage || hidden ? 'aspect-[4/5] max-h-[30vh]' : 'aspect-video max-h-[160px]'
        )}
        emptyIcon="route"
        overlay={
          <div className="absolute left-2 top-2">
            <RankChip rank={child.rank} onImage />
          </div>
        }
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 @md:px-1 @md:py-1.5">
        <Text size="xs" fw={700} c="dimmed" tt="uppercase" className="tracking-wide">
          Keep reading
        </Text>
        <div>
          <Text
            className="text-[21px] font-extrabold leading-tight @md:text-[26px]"
            c={hidden ? 'dimmed' : undefined}
            lineClamp={3}
            data-testid="storyline-fork-name"
          >
            {name}
          </Text>
          <Text size="sm" c="dimmed" mt={6} data-testid="storyline-fork-byline">
            {byline(child)}
          </Text>
        </div>
        <div className="mt-auto">
          {/* Nothing while the shares load or fail: "be the first" is only true at zero. */}
          {share ? (
            <>
              <div className="flex items-center gap-2.5">
                <Text className="text-[22px] font-extrabold" data-testid="storyline-share-percent">
                  {share.percent}%
                </Text>
                <ShareBar percent={share.percent} hidden={hidden} />
              </div>
              <Text size="xs" c="dimmed" mt={3} data-testid="storyline-share-caption">
                of readers went this way · {share.readers}{' '}
                {share.readers === 1 ? 'reader' : 'readers'}
              </Text>
            </>
          ) : (
            shares?.total === 0 && (
              <Text size="sm" c="dimmed" data-testid="storyline-share-first">
                Be the first to choose
              </Text>
            )
          )}
        </div>
        {hidden ? (
          <ForkOpener child={child} name={name} onContinue={onContinue} />
        ) : (
          <Button
            size="lg"
            rightSection={
              hotkey ? (
                <Kbd size="xs" aria-hidden data-testid="storyline-read-next-hotkey">
                  →
                </Kbd>
              ) : (
                <IconArrowRight size={18} />
              )
            }
            onClick={() => onContinue(child)}
            className="w-full @md:w-auto @md:self-start"
            data-testid="storyline-read-next"
          >
            Read chapter {child.depth + 1}
          </Button>
        )}
        {onMakeMain && <MakeMainButton onClick={onMakeMain} loading={makingMain} />}
      </div>
    </div>
  );
}

function OtherFork({
  child,
  shares,
  onContinue,
  onMakeMain,
  makingMain = false,
}: {
  child: StorylineChild;
  shares: StorylineShares;
  onContinue: (child: StorylineChild) => void;
  onMakeMain?: () => void;
  makingMain?: boolean;
}) {
  const hidden = !child.post;
  const share = getForkShare(shares, child.chapterId);
  const name = getStorylineChapterName(child);

  return (
    <div
      {...forkAttrs(child)}
      className={clsx(
        'flex w-[150px] flex-none flex-col gap-2.5 p-2.5 @md:w-auto @md:flex-row @md:gap-3',
        hidden ? hiddenCardClass : cardClass
      )}
    >
      <StorylineChapterImage
        image={child.firstImage}
        hidden={hidden}
        className="aspect-[3/4] w-full @md:w-[84px] @md:flex-none"
        emptyIcon="photo"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="min-h-[22px]">
          <RankChip rank={child.rank} />
        </div>
        <Text
          fw={700}
          size="sm"
          lineClamp={2}
          c={hidden ? 'dimmed' : undefined}
          className="leading-tight"
          data-testid="storyline-fork-name"
        >
          {name}
        </Text>
        <Text size="xs" c="dimmed" data-testid="storyline-fork-byline">
          {byline(child)}
        </Text>
        {share && (
          <div className="mt-auto flex items-center gap-2">
            <ShareBar percent={share.percent} hidden={hidden} />
            <Text
              size="xs"
              fw={700}
              c={hidden ? 'dimmed' : undefined}
              data-testid="storyline-share-percent"
            >
              {share.percent}%
            </Text>
          </div>
        )}
        {onMakeMain && <MakeMainButton onClick={onMakeMain} loading={makingMain} />}
      </div>
      <ForkOpener child={child} name={name} onContinue={onContinue} />
    </div>
  );
}

/**
 * The whole card opens the way on, under the image's own blur toggle. A hidden chapter opens too,
 * so the story can go on past it.
 */
function ForkOpener({
  child,
  name,
  onContinue,
}: {
  child: StorylineChild;
  name: string;
  onContinue: (child: StorylineChild) => void;
}) {
  return (
    <UnstyledButton
      onClick={() => onContinue(child)}
      aria-label={child.post ? `Read ${name}` : `Continue past a hidden chapter: ${name}`}
      className="absolute inset-0 rounded-xl"
      data-testid="storyline-fork-open"
    />
  );
}

function LeadSkeleton() {
  return (
    <div
      className={clsx(cardClass, 'flex flex-col gap-4 p-3 @md:flex-row')}
      data-testid="storyline-end-skeleton"
    >
      <Skeleton className="aspect-[4/5] w-full rounded-lg @md:w-[210px] @md:flex-none" />
      <div className="flex flex-1 flex-col gap-3 py-1.5">
        <Skeleton h={12} w={90} />
        <Skeleton h={26} w="70%" />
        <Skeleton h={14} w="40%" />
      </div>
    </div>
  );
}

const closedCopy = {
  closed: 'Closed to new chapters',
  collaboratorsOnly: 'Collaborators only',
} as const;

export function StorylineContinueWithPost({ parentPostId }: { parentPostId: number }) {
  const terms = useStorylineContinueTerms(parentPostId);
  if (!terms) return null;
  if (!terms.open)
    return terms.closedReason ? (
      <Badge
        size="lg"
        radius="xl"
        variant="light"
        color="gray"
        leftSection={<IconLock size={14} />}
        className="normal-case"
        data-testid="storyline-continue-closed"
      >
        {closedCopy[terms.closedReason]}
      </Badge>
    ) : null;

  return (
    <Anchor
      component="button"
      type="button"
      size="sm"
      onClick={() => openStorylineContinueModal({ parentPostId })}
      data-testid="storyline-continue-with-post"
    >
      or use a post you already made
    </Anchor>
  );
}
