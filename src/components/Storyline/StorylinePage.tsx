import { ActionIcon, Alert, Button, Container, Skeleton, Text, Title } from '@mantine/core';
import {
  IconBolt,
  IconBook2,
  IconCircleCheck,
  IconEye,
  IconFiles,
  IconLock,
  IconPlayerPlayFilled,
  IconPlus,
  IconRosetteDiscountCheck,
  IconSettings,
  IconShieldHalf,
  IconUsers,
} from '@tabler/icons-react';
import type { Icon as TablerIcon } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { FLAG_ALERT_MESSAGES } from '~/components/Model/minor-flag-alert-state';
import { FlagAppealAlert } from '~/components/Moderation/FlagAppealAlert';
import { EntityDiscussion } from '~/components/CommentsV2/EntityDiscussion';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { openStorylineContinueModal } from '~/components/Storyline/continue/openStorylineContinueModal';
import { openStorylineManageModal } from '~/components/Storyline/manage/openStorylineManageModal';
import { openStorylineFirstChapterModal } from '~/components/Storyline/openStorylineFirstChapterModal';
import {
  StorylineClosedChip,
  StorylineRoleChip,
  StorylineStat,
  StorylineStatusChip,
  storylineCardClass,
} from '~/components/Storyline/StorylineChips';
import { storylineWriteChapterUrl } from '~/components/Storyline/storyline-routes';
import { StorylineContextMenu } from '~/components/Storyline/StorylineContextMenu';
import { StorylineHero } from '~/components/Storyline/StorylineCover';
import { StorylineInviteAlert } from '~/components/Storyline/StorylineInviteAlert';
import { StorylineChapterLanes } from '~/components/Storyline/StorylineLaneMap';
import { storylineChapterLink } from '~/components/Storyline/storyline-mode.utils';
import { storylineChapterLinkProps } from '~/components/Storyline/storyline-read-link';
import { useStorylineContinueTerms } from '~/components/Storyline/storyline.queries';
import { storylinePriceLabel } from '~/components/Storyline/storyline-ui';
import { StorylineThumb } from '~/components/Storyline/StorylineThumb';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { RouterOutput } from '~/types/router';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { EntityType } from '~/shared/utils/prisma/enums';
import { STORYLINE_CEILING_LEVELS } from '~/shared/utils/storyline';
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
        {storyline.viewerInvited && (
          <StorylineInviteAlert
            storylineId={storyline.id}
            ownerUsername={storyline.user.username}
          />
        )}
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
            // The thread keeps its own top margin for the pages it stands alone on; here the card's
            // padding is the only space above it.
            <section
              aria-label="Discussion"
              className={clsx(storylineCardClass, 'p-3.5 sm:p-5 [&>.mantine-Stack-root]:!mt-0')}
            >
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
  const currentUser = useCurrentUser();
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
            <StorylineClosedNotice storyline={storyline} terms={terms} />
          </div>
          <Title order={1} fw={800} lh={1.05} className="break-words text-[26px] sm:text-[40px]">
            {storyline.title}
          </Title>
          <div className="mt-2 flex flex-wrap gap-3.5">
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
        </div>
      </div>

      <div className="flex flex-col gap-2.5 md:items-end">
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
          {!startLink && storyline.chapterCount === 0 && storyline.viewerRole === 'owner' && (
            <Button
              variant="default"
              size="lg"
              // Its own row on a phone, after Manage, so neither label is cut off.
              className="order-last grow basis-full sm:order-none sm:grow-0 sm:basis-auto"
              leftSection={<IconFiles size={18} />}
              onClick={() => openStorylineFirstChapterModal({ storylineId: storyline.id })}
            >
              Use a post you&apos;ve published
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
          {(storyline.viewerRole === 'owner' || currentUser?.isModerator) && (
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
          <StorylineContextMenu storyline={storyline} isOwner={storyline.viewerRole === 'owner'} />
        </div>
      </div>
    </header>
  );
}

function StorylineClosedNotice({
  storyline,
  terms,
}: {
  storyline: Storyline;
  terms: ContinueTerms;
}) {
  if (!terms || storyline.status === 'Complete') return null;
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
      {/* Pulled out to the card's edges so each divider runs the full width. */}
      <ul className="m-0 -mx-3.5 flex list-none flex-col divide-x-0 divide-y divide-solid divide-gray-3 p-0 sm:-mx-5 dark:divide-dark-4">
        {contributors.map(({ user, role, chapterCount }) => (
          <li
            key={user.id}
            className="flex items-center justify-between gap-2 px-3.5 py-2.5 first:pt-0 last:pb-0 sm:px-5"
          >
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

function Detail({
  icon: Icon,
  children,
  testId,
}: {
  icon: TablerIcon;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <li className="flex items-start gap-2.5" data-testid={testId}>
      <Icon size={18} className="text-dimmed mt-px shrink-0" aria-hidden />
      <Text size="sm">{children}</Text>
    </li>
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
  const complete = storyline.status === 'Complete';
  const ceiling = (STORYLINE_CEILING_LEVELS as readonly number[]).includes(storyline.maxNsfwLevel)
    ? browsingLevelLabels[storyline.maxNsfwLevel as keyof typeof browsingLevelLabels]
    : null;
  return (
    <Section title="About continuing" id="storyline-about-continuing">
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {complete ? (
          <Detail icon={IconCircleCheck}>
            This storyline is complete and takes no more chapters.
          </Detail>
        ) : terms?.closedReason === 'closed' ? (
          <Detail icon={IconLock}>This storyline is not taking new chapters right now.</Detail>
        ) : storyline.whoCanContinue === 'Collaborators' ? (
          <Detail icon={IconLock}>Only {owner}&apos;s collaborators can continue it.</Detail>
        ) : (
          <>
            <Detail icon={IconUsers}>Anyone can continue</Detail>
            <Detail icon={IconEye}>{owner} reviews each one</Detail>
            <Detail icon={IconRosetteDiscountCheck}>Endorsed collaborators skip review</Detail>
          </>
        )}
        {terms?.open && !complete && (
          <Detail icon={IconBolt} testId="storyline-price-detail">
            {terms.price > 0
              ? `${storylinePriceLabel(terms.price)} to continue`
              : 'Free to continue'}
          </Detail>
        )}
        {ceiling && (
          <Detail icon={IconShieldHalf} testId="storyline-ceiling-detail">
            Up to {ceiling}
          </Detail>
        )}
      </ul>
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
