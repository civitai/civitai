import { ActionIcon, Alert, Button, Container, Skeleton, Text, Title } from '@mantine/core';
import {
  IconBook2,
  IconPlayerPlayFilled,
  IconPlus,
  IconSettings,
  IconUsers,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { FLAG_ALERT_MESSAGES } from '~/components/Model/minor-flag-alert-state';
import { FlagAppealAlert } from '~/components/Moderation/FlagAppealAlert';
import { EntityDiscussion } from '~/components/CommentsV2/EntityDiscussion';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { openStorylineContinueModal } from '~/components/Storyline/continue/openStorylineContinueModal';
import { openStorylineManageModal } from '~/components/Storyline/manage/openStorylineManageModal';
import {
  StorylineCeilingChip,
  StorylineClosedChip,
  StorylinePriceChip,
  StorylineRoleChip,
  StorylineStat,
  StorylineStatusChip,
  storylineCardClass,
} from '~/components/Storyline/StorylineChips';
import { storylineWriteChapterUrl } from '~/components/Storyline/storyline-routes';
import { StorylineContextMenu } from '~/components/Storyline/StorylineContextMenu';
import { StorylineHero } from '~/components/Storyline/StorylineCover';
import { StorylineChapterLanes } from '~/components/Storyline/StorylineLaneMap';
import { storylineChapterLink } from '~/components/Storyline/storyline-mode.utils';
import { storylineChapterLinkProps } from '~/components/Storyline/storyline-read-link';
import { useStorylineContinueTerms } from '~/components/Storyline/storyline.queries';
import { StorylineThumb } from '~/components/Storyline/StorylineThumb';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import type { RouterOutput } from '~/types/router';
import { EntityType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

type Storyline = RouterOutput['storyline']['getById'];
type ContinueTerms = ReturnType<typeof useStorylineContinueTerms>;
type ChapterLink = NonNullable<ReturnType<typeof storylineChapterLink>>;

export function StorylinePage({ id }: { id: number }) {
  const storylineQuery = trpc.storyline.getById.useQuery({ id });
  const queryUtils = trpc.useUtils();
  const storyline = storylineQuery.data;
  const mainPath = storyline?.mainPath ?? [];
  // Start reading comes from the reading path, which tombstones chapter 1 where this reader may
  // not see it; `rootPostId` does not.
  const startLink = mainPath[0] ? storylineChapterLink(mainPath[0], []) : null;
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
      <StorylineHero
        image={storyline.heroImage}
        position={storyline.heroImagePosition}
        backdrop={!storyline.heroIsBanner}
      />
      <Container size="lg" className="relative mt-[-70px] flex flex-col gap-5 sm:mt-[-120px]">
        <StorylineHeader
          storyline={storyline}
          startLink={startLink}
          lastPostId={lastPost?.id ?? null}
          terms={shownTerms}
        />
        {storyline.titleAppealable && (
          <FlagAppealAlert
            entityType={EntityType.Storyline}
            entityId={storyline.id}
            message={FLAG_ALERT_MESSAGES.storylineTitle}
            appeal={storyline.titleAppeal}
            onRequested={() => queryUtils.storyline.getById.invalidate({ id })}
          />
        )}

        <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-5">
            <StorylineChapters storyline={storyline} />
          </div>
          {/* On a phone this column comes before the discussion. */}
          <div className="flex flex-col gap-5 md:col-start-2 md:row-span-2 md:row-start-1">
            <StorylineContributors contributors={storyline.contributors} />
            <StorylineAboutContinuing storyline={storyline} terms={shownTerms} />
          </div>
          {/* A storyline with no chapter 1 yet is its owner's draft, with nothing to discuss. */}
          {mainPath.length > 0 && (
            // The thread brings its own "Comments" heading; the card only names the region.
            <section aria-label="Discussion" className={clsx(storylineCardClass, 'p-3.5 sm:p-5')}>
              <EntityDiscussion
                entityType="storyline"
                entityId={storyline.id}
                userId={storyline.user.id}
              />
            </section>
          )}
        </div>
      </Container>
    </div>
  );
}

function StorylineHeader({
  storyline,
  startLink,
  lastPostId,
  terms,
}: {
  storyline: Storyline;
  startLink: ChapterLink | null;
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
          {startLink && (
            <Button
              component={Link}
              {...storylineChapterLinkProps(startLink)}
              size="lg"
              className="grow basis-[140px] sm:grow-0 sm:basis-auto"
              leftSection={<IconPlayerPlayFilled size={18} />}
            >
              Start reading
            </Button>
          )}
          {!startLink && storyline.chapterCount === 0 && storyline.viewerRole === 'owner' && (
            <Button
              component={Link}
              href={storylineWriteChapterUrl(storyline.id)}
              size="lg"
              className="grow basis-[140px] sm:grow-0 sm:basis-auto"
              leftSection={<IconPlus size={18} />}
            >
              Write chapter 1
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
          <StorylineContextMenu
            storylineId={storyline.id}
            isOwner={storyline.viewerRole === 'owner'}
          />
        </div>
      </div>
    </header>
  );
}

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

function StorylineChapters({ storyline }: { storyline: Storyline }) {
  return (
    <Section icon={<IconBook2 size={20} />} title="Chapters" id="storyline-chapters">
      <StorylineChapterLanes storyline={storyline} />
    </Section>
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
