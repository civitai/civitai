import { ActionIcon, Alert, Button, Container, Skeleton, Text, Title } from '@mantine/core';
import {
  IconBook2,
  IconEyeOff,
  IconGitFork,
  IconPlayerPlayFilled,
  IconPlus,
  IconSettings,
  IconUsers,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PostComments } from '~/components/Post/Detail/PostComments';
import { openStorylineContinueModal } from '~/components/Storyline/continue/openStorylineContinueModal';
import { openStorylineManageModal } from '~/components/Storyline/manage/openStorylineManageModal';
import {
  StorylineCeilingChip,
  StorylineClosedChip,
  StorylinePriceChip,
  StorylineRankChip,
  StorylineRoleChip,
  StorylineShareChip,
  StorylineStat,
  StorylineStatusChip,
  storylineCardClass,
} from '~/components/Storyline/StorylineChips';
import { StorylineHero } from '~/components/Storyline/StorylineCover';
import {
  getForkShare,
  getStorylineChapterName,
  getStorylineTombstoneLabel,
} from '~/components/Storyline/storyline-mode.utils';
import {
  useStorylineChildren,
  useStorylineContinueTerms,
  useStorylineForkShares,
} from '~/components/Storyline/storyline.queries';
import { StorylineThumb } from '~/components/Storyline/StorylineThumb';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import type { RouterOutput } from '~/types/router';
import { trpc } from '~/utils/trpc';

type Storyline = RouterOutput['storyline']['getById'];
type PathChapter = Storyline['mainPath'][number];
type ContinueTerms = ReturnType<typeof useStorylineContinueTerms>;

export function StorylinePage({ id }: { id: number }) {
  const storylineQuery = trpc.storyline.getById.useQuery({ id });
  const storyline = storylineQuery.data;
  const mainPath = storyline?.mainPath ?? [];
  // Cover, thread and Start reading come from the reading path, which tombstones chapter 1 where
  // this reader may not see it; `rootPostId` does not.
  const rootPost = mainPath[0]?.post ?? null;
  // Continue adds the next chapter after the end of the main path. When that chapter is hidden
  // from this reader, Continue is not offered: continuing an earlier one would make a side branch.
  const lastPost = mainPath.at(-1)?.post ?? null;
  const terms = useStorylineContinueTerms(lastPost?.id);
  // The server tells the owner "closed": they add chapters directly, never as a continuation.
  // That is about them, not the storyline, so the owner is shown no closed chip or sentence.
  const shownTerms = storyline?.viewerRole === 'owner' ? null : terms;

  if (storylineQuery.isLoading) return <StorylinePageSkeleton />;
  if (!storyline)
    return (
      <Container size="sm" py="xl">
        <Alert color="gray">
          This storyline doesn&apos;t exist or isn&apos;t available to you.
        </Alert>
      </Container>
    );

  return (
    <div className="pb-10">
      {/* Only a picked banner shows sharp; the fallback is a portrait, so a blurred backdrop. */}
      <StorylineHero
        image={storyline.heroImage}
        position={storyline.heroImagePosition}
        backdrop={!storyline.heroIsBanner}
      />
      <Container size="lg" className="relative mt-[-70px] flex flex-col gap-5 sm:mt-[-120px]">
        <StorylineHeader
          storyline={storyline}
          rootPostId={rootPost?.id ?? null}
          lastPostId={lastPost?.id ?? null}
          terms={shownTerms}
        />

        <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-[minmax(0,1fr)_320px]">
          <StorylineChapters storyline={storyline} />
          {/* Spans both rows on desktop; on a phone it comes before the discussion. */}
          <div className="flex flex-col gap-5 md:col-start-2 md:row-span-2 md:row-start-1">
            <StorylineContributors contributors={storyline.contributors} />
            <StorylineAboutContinuing storyline={storyline} terms={shownTerms} />
          </div>
          {rootPost && (
            // The thread brings its own "Comments" heading; the card only names the region.
            <section aria-label="Discussion" className={clsx(storylineCardClass, 'p-3.5 sm:p-5')}>
              <PostComments postId={rootPost.id} userId={storyline.user.id} />
            </section>
          )}
        </div>
      </Container>
    </div>
  );
}

function StorylineHeader({
  storyline,
  rootPostId,
  lastPostId,
  terms,
}: {
  storyline: Storyline;
  rootPostId: number | null;
  lastPostId: number | null;
  terms: ContinueTerms;
}) {
  return (
    <header
      className={clsx(
        storylineCardClass,
        'flex flex-col gap-4 p-3.5 sm:p-5 md:flex-row md:items-end'
      )}
    >
      <div className="flex min-w-0 flex-1 items-end gap-3.5">
        <div className="mt-[-50px] w-[92px] shrink-0 sm:mt-[-80px] sm:w-[150px]">
          <StorylineThumb
            image={storyline.coverImage}
            width={150}
            fluid
            className="rounded-[10px] border-[3px] border-solid border-gray-0 shadow-lg dark:border-dark-6"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap gap-1.5">
            <StorylineStatusChip status={storyline.status} />
            <StorylineCeilingChip maxNsfwLevel={storyline.maxNsfwLevel} />
            <StorylineContinueChip storyline={storyline} terms={terms} />
          </div>
          <Title order={1} fw={800} lh={1.05} className="break-words text-[26px] sm:text-[40px]">
            {storyline.title}
          </Title>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <Text span size="sm" c="dimmed">
              Started by
            </Text>
            <UserAvatar user={storyline.user} withUsername linkToProfile size="sm" />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2.5 md:items-end">
        <div className="flex flex-wrap gap-3.5">
          <StorylineStat
            icon={IconBook2}
            count={storyline.chapterCount}
            one="chapter"
            many="chapters"
            showLabel
            size="sm"
          />
          <StorylineStat
            icon={IconUsers}
            count={storyline.contributorCount}
            one="creator"
            many="creators"
            showLabel
            size="sm"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {rootPostId && (
            <Button
              component={Link}
              href={`/posts/${rootPostId}`}
              size="lg"
              className="grow basis-[140px] sm:grow-0 sm:basis-auto"
              leftSection={<IconPlayerPlayFilled size={18} />}
            >
              Start reading
            </Button>
          )}
          {lastPostId && terms?.open && storyline.status !== 'Complete' && (
            <Button
              variant="default"
              size="lg"
              className="grow basis-[140px] sm:grow-0 sm:basis-auto"
              leftSection={<IconPlus size={18} />}
              onClick={() => openStorylineContinueModal({ parentPostId: lastPostId })}
            >
              Continue the story
            </Button>
          )}
          {storyline.viewerRole === 'owner' && (
            <ActionIcon
              variant="default"
              size={50}
              radius="md"
              aria-label="Manage"
              className="shrink-0"
              onClick={() => openStorylineManageModal({ storylineId: storyline.id })}
            >
              <IconSettings size={20} />
            </ActionIcon>
          )}
        </div>
      </div>
    </header>
  );
}

/** The price when this reader can continue; otherwise why not, when the server says. */
function StorylineContinueChip({
  storyline,
  terms,
}: {
  storyline: Storyline;
  terms: ContinueTerms;
}) {
  if (!terms || storyline.status === 'Complete') return null;
  if (terms.open) return <StorylinePriceChip price={terms.price} />;
  if (terms.closedReason === 'collaboratorsOnly')
    return <StorylineClosedChip label="Collaborators only" />;
  if (terms.closedReason === 'closed') return <StorylineClosedChip label="Closed" />;
  return null;
}

function Section({
  icon,
  title,
  id,
  aside,
  children,
}: {
  icon?: ReactNode;
  title: string;
  id: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={clsx(storylineCardClass, 'p-3.5 sm:p-5')}>
      <div className="mb-3.5 flex items-center justify-between gap-2">
        <Title order={2} id={id} fz={18} fw={800} className="flex items-center gap-2">
          {icon}
          {title}
        </Title>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The canon path as a reading line: one stop per chapter, the forks noted where they happen. */
function StorylineChapters({ storyline }: { storyline: Storyline }) {
  const collaboratorIds = new Set(storyline.collaborators.map((c) => c.id));
  return (
    <Section
      icon={<IconBook2 size={20} />}
      title="Chapters"
      id="storyline-chapters"
      aside={
        <Text size="sm" c="dimmed">
          Canon path
        </Text>
      }
    >
      <ol className="relative m-0 list-none p-0">
        <span
          aria-hidden
          className="absolute bottom-6 left-[11px] top-3 w-0.5 bg-[var(--mantine-color-blue-6)] opacity-45"
        />
        {storyline.mainPath.map((chapter) => (
          <ChapterStop
            key={chapter.chapterId}
            chapter={chapter}
            endorsed={!!chapter.post && collaboratorIds.has(chapter.post.userId)}
          />
        ))}
      </ol>
    </Section>
  );
}

function ChapterStop({ chapter, endorsed }: { chapter: PathChapter; endorsed: boolean }) {
  const number = chapter.depth + 1;
  const { post } = chapter;
  return (
    <li className="relative pb-[18px] pl-9" data-testid="storyline-chapter">
      <span
        aria-hidden
        className={clsx(
          'absolute left-0 top-0.5 flex size-6 items-center justify-center rounded-full text-xs font-extrabold text-white shadow-[0_0_0_4px_var(--mantine-color-gray-0)] dark:shadow-[0_0_0_4px_var(--mantine-color-dark-6)]',
          post ? 'bg-[var(--mantine-color-blue-6)]' : 'bg-gray-5 dark:bg-dark-3'
        )}
      >
        {number}
      </span>
      {post ? (
        <div className="flex gap-3.5">
          {/* The name below is the link; the picture repeats it for the pointer only. */}
          <Link
            href={`/posts/${post.id}`}
            tabIndex={-1}
            aria-hidden
            className="w-[84px] shrink-0 sm:w-[112px]"
          >
            <StorylineThumb
              image={chapter.firstImage}
              width={112}
              ratio="4/5"
              fluid
              className="rounded-lg"
            />
          </Link>
          <div className="min-w-0 flex-1 pt-0.5">
            {/* An untitled chapter is named by its number, so the eyebrow would only repeat it. */}
            {post.title && (
              <Text size="xs" fw={700} c="dimmed">
                Chapter {number}
              </Text>
            )}
            <Text
              component={Link}
              href={`/posts/${post.id}`}
              fw={700}
              lh={1.25}
              className="text-[15px] hover:underline sm:text-[17px]"
            >
              {post.title || `Chapter ${number}`}
            </Text>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <UserAvatar user={post.user} withUsername linkToProfile size="xs" />
              {endorsed && <StorylineRoleChip role="endorsed" />}
            </div>
          </div>
        </div>
      ) : (
        <Text size="sm" c="dimmed" className="pt-0.5">
          {getStorylineTombstoneLabel(chapter.tombstone ?? 'deleted')}
        </Text>
      )}
      {chapter.childCount > 1 && (
        <StorylineForkPaths chapterId={chapter.chapterId} count={chapter.childCount} />
      )}
    </li>
  );
}

/** Where the story forks: each way on, as the end of the chapter ranks it, with its reader share. */
function StorylineForkPaths({ chapterId, count }: { chapterId: number; count: number }) {
  const { data: children } = useStorylineChildren(chapterId);
  const { data: shares } = useStorylineForkShares(chapterId);
  return (
    <div
      className="mt-2.5 rounded-lg bg-gray-1 px-3 py-2.5 dark:bg-dark-5"
      data-testid="storyline-fork"
    >
      <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-gray-6 dark:text-dark-1">
        <IconGitFork size={14} aria-hidden />
        The story forks here · {count} paths
      </div>
      {children && (
        <ul className="m-0 mt-2.5 flex list-none gap-2.5 overflow-x-auto p-0 pb-1">
          {children.map((child) => {
            const share = getForkShare(shares, child.chapterId);
            const name = getStorylineChapterName(child);
            return (
              <li
                key={child.chapterId}
                className="w-[120px] shrink-0 sm:w-[140px]"
                data-testid="storyline-fork-path"
              >
                {child.post ? (
                  <>
                    <Link href={`/posts/${child.post.id}`} className="group block">
                      <StorylineThumb
                        image={child.firstImage}
                        width={140}
                        fluid
                        className="rounded-lg"
                      >
                        <span className="absolute left-1.5 top-1.5">
                          <StorylineRankChip rank={child.rank} onImage />
                        </span>
                        {share && (
                          <StorylineShareChip
                            percent={share.percent}
                            className="absolute bottom-1.5 right-1.5"
                          />
                        )}
                      </StorylineThumb>
                      <Text
                        size="sm"
                        fw={700}
                        lh={1.2}
                        mt={6}
                        lineClamp={2}
                        className="group-hover:underline"
                      >
                        {name}
                      </Text>
                    </Link>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {child.post.username}
                    </Text>
                  </>
                ) : (
                  // A way on this reader may not see keeps its place and share, with no link.
                  <div className="relative flex aspect-[3/4] flex-col items-center justify-center gap-1.5 rounded-lg border-[1.5px] border-dashed border-gray-4 p-2 text-center dark:border-dark-3">
                    <IconEyeOff size={22} className="text-gray-6 dark:text-dark-2" aria-hidden />
                    <Text size="xs" c="dimmed" lh={1.25}>
                      {name}
                    </Text>
                    {share && (
                      <StorylineShareChip
                        percent={share.percent}
                        className="absolute bottom-1.5 right-1.5"
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StorylineContributors({ contributors }: { contributors: Storyline['contributors'] }) {
  return (
    <Section icon={<IconUsers size={18} />} title="Contributors" id="storyline-contributors">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {contributors.map(({ user, role, chapterCount }) => (
          <li key={user.id} className="flex items-center justify-between gap-2">
            <UserAvatar
              user={user}
              withUsername
              linkToProfile
              size="md"
              withDecorations
              subText={`${chapterCount} ${chapterCount === 1 ? 'chapter' : 'chapters'}`}
            />
            <StorylineRoleChip role={role} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Price and ceiling, and in one sentence who may continue and who reviews it. */
function StorylineAboutContinuing({
  storyline,
  terms,
}: {
  storyline: Storyline;
  terms: ContinueTerms;
}) {
  const owner = storyline.user.username ?? 'The creator';
  const sentence =
    storyline.status === 'Complete'
      ? 'This storyline is complete and takes no more chapters.'
      : terms?.closedReason === 'closed'
      ? 'This storyline is not taking new chapters right now.'
      : storyline.whoCanContinue === 'Collaborators'
      ? `Only ${owner}'s collaborators can continue it.`
      : `Anyone can continue. ${owner} reviews each one; endorsed collaborators skip review.`;
  return (
    <Section title="About continuing" id="storyline-about-continuing">
      <div className="flex flex-wrap gap-1.5">
        {terms?.open && storyline.status !== 'Complete' && (
          <StorylinePriceChip price={terms.price} />
        )}
        <StorylineCeilingChip maxNsfwLevel={storyline.maxNsfwLevel} />
      </div>
      <Text size="sm" c="dimmed" mt={8}>
        {sentence}
      </Text>
    </Section>
  );
}

function StorylinePageSkeleton() {
  return (
    <div aria-busy data-testid="storyline-page-skeleton">
      <Skeleton className="h-[220px] sm:h-[340px]" radius={0} />
      <Container size="lg" className="relative mt-[-70px] sm:mt-[-120px]">
        <div className={clsx(storylineCardClass, 'flex items-end gap-3.5 p-5')}>
          <Skeleton className="mt-[-50px] aspect-[3/4] w-[92px] sm:mt-[-80px] sm:w-[150px]" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton height={14} width="30%" />
            <Skeleton height={28} width="60%" />
          </div>
        </div>
      </Container>
    </div>
  );
}
