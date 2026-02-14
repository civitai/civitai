import {
  Accordion,
  ActionIcon,
  Badge,
  Button,
  Container,
  Divider,
  Drawer,
  Group,
  Indicator,
  Loader,
  Menu,
  Paper,
  type PaperProps,
  ScrollArea,
  Spoiler,
  Stack,
  Text,
  Popover,
  Progress,
  ThemeIcon,
  Title,
  useMantineTheme,
  useComputedColorScheme,
} from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as z from 'zod';

import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { ToggleLockComments } from '~/components/CommentsV2/ToggleLockComments';
import { Page } from '~/components/AppLayout/Page';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { CreatorCardSimple } from '~/components/CreatorCard/CreatorCardSimple';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import {
  ChallengeReviewCostType,
  Currency,
  ChallengeStatus,
  PrizeMode,
  PoolTrigger,
} from '~/shared/utils/prisma/enums';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import {
  IconBrush,
  IconBulb,
  IconCheck,
  IconClockHour4,
  IconCrown,
  IconCube,
  IconDotsVertical,
  IconFilter,
  IconGift,
  IconInfoCircle,
  IconPencil,
  IconPhoto,
  IconShare3,
  IconSparkles,
  IconLock,
  IconTrash,
  IconTrendingUp,
  IconTrophy,
  IconX,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { useQueryChallenge } from '~/components/Challenge/challenge.utils';
import type { Props as DescriptionTableProps } from '~/components/DescriptionTable/DescriptionTable';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { slugit } from '~/utils/string-helpers';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { env } from '~/env/client';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { MediaType } from '~/shared/utils/prisma/enums';
import { NoContent } from '~/components/NoContent/NoContent';
import type { ChallengeDetail } from '~/server/schema/challenge.schema';
import { generationFormStore, generationPanel } from '~/store/generation.store';
import { trpc } from '~/utils/trpc';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { ChallengeSubmitModal } from '~/components/Challenge/ChallengeSubmitModal';
import {
  parseBitwiseBrowsingLevel,
  browsingLevelLabels,
  nsfwLevelColors,
} from '~/shared/constants/browsingLevel.constants';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { JudgeScoreBadge } from '~/components/Image/JudgeScoreBadge/JudgeScoreBadge';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { constants as appConstants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { ChallengeDiscussion } from '~/components/Challenge/ChallengeDiscussion';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';
import { IsClient } from '~/components/IsClient/IsClient';
import { useIsMobile } from '~/hooks/useIsMobile';
import { getBorder, getBackground, getShadow, PREVIEW_STATES } from '~/components/Challenge/DynamicPrizeCard/constants';
import { ProgressLegendDot } from '~/components/Challenge/DynamicPrizeCard/ProgressLegendDot';
import { GlowDivider } from '~/components/Challenge/DynamicPrizeCard/GlowDivider';

function useInjectKeyframes() {
  useEffect(() => {
    const id = 'challenge-spotlight-keyframes';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `@keyframes sweep-fill-pulse {
  0% { background-position: 100% 0; opacity: 1; }
  35% { background-position: 0% 0; opacity: 1; }
  55% { opacity: 0.6; }
  70% { opacity: 1; }
  85% { opacity: 0.6; }
  100% { background-position: 0% 0; opacity: 1; }
}
@keyframes prize-shimmer {
  0% { background-position: -200% center; }
  100% { background-position: 200% center; }
}
@keyframes prize-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.85; transform: scale(1.02); }
}`;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);
}

/** Open the generation panel for a challenge's model versions. */
function openChallengeGenerator(modelVersionIds: number[]) {
  if (modelVersionIds.length) {
    generationPanel.open({ type: 'modelVersions', ids: modelVersionIds.slice(0, 1) });
  } else {
    generationPanel.open();
  }
  generationFormStore.setType('image');
}

const querySchema = z.object({
  id: z.coerce.number(),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg, features }) => {
    if (!features?.challengePlatform) return { notFound: true };

    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };

    if (ssg) {
      await ssg.challenge.getById.prefetch({ id: result.data.id });
    }

    return { props: removeEmpty(result.data) };
  },
});

function ChallengeDetailsPage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { data: challenge, isLoading } = useQueryChallenge(id);
  const currentUser = useCurrentUser();
  const router = useRouter();
  const queryUtils = trpc.useUtils();

  const handleMutationError = (error: { message: string }) => {
    showErrorNotification({ error: new Error(error.message) });
  };

  const endAndPickWinnersMutation = trpc.challenge.endAndPickWinners.useMutation({
    onSuccess: (data) => {
      queryUtils.challenge.getById.invalidate({ id });
      showSuccessNotification({
        message: `Challenge ended. ${data.winnersCount} winner(s) selected.`,
      });
    },
    onError: handleMutationError,
  });

  const voidChallengeMutation = trpc.challenge.voidChallenge.useMutation({
    onSuccess: () => {
      queryUtils.challenge.getById.invalidate({ id });
      showSuccessNotification({ message: 'Challenge cancelled' });
    },
    onError: handleMutationError,
  });

  const deleteMutation = trpc.challenge.delete.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'Challenge deleted' });
      router.push('/challenges');
    },
    onError: handleMutationError,
  });

  const handleEndAndPickWinners = () => {
    if (!challenge) return;
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'End & Pick Winners',
        message: (
          <Stack gap="xs">
            <Text>
              Are you sure you want to end <strong>&ldquo;{challenge.title}&rdquo;</strong> and pick
              winners now?
            </Text>
            <Text size="sm" c="dimmed">
              This will close the collection, run the winner selection process, and award prizes.
            </Text>
          </Stack>
        ),
        labels: { cancel: 'Cancel', confirm: 'End & Pick Winners' },
        onConfirm: () => endAndPickWinnersMutation.mutateAsync({ id }),
      },
    });
  };

  const handleVoidChallenge = () => {
    if (!challenge) return;
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Void Challenge',
        message: (
          <Stack gap="xs">
            <Text>
              Are you sure you want to void <strong>&ldquo;{challenge.title}&rdquo;</strong>?
            </Text>
            <Text size="sm" c="dimmed">
              This will cancel the challenge without picking winners. Users will keep their entry
              prizes (if any were awarded).
            </Text>
          </Stack>
        ),
        labels: { cancel: 'Cancel', confirm: 'Void Challenge' },
        confirmProps: { color: 'red' },
        onConfirm: () => voidChallengeMutation.mutateAsync({ id }),
      },
    });
  };

  const handleDelete = () => {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Delete Challenge',
        message: <Text>Are you sure you want to delete this challenge?</Text>,
        labels: { cancel: 'Cancel', confirm: 'Delete' },
        confirmProps: { color: 'red' },
        onConfirm: () => deleteMutation.mutateAsync({ id }),
      },
    });
  };

  if (isLoading) return <PageLoader />;
  if (!challenge) return <NotFound />;

  const isActive = challenge.status === ChallengeStatus.Active;
  const isCompleted = challenge.status === ChallengeStatus.Completed;
  const isScheduled = challenge.status === ChallengeStatus.Scheduled;

  return (
    <>
      <Meta
        title={`${challenge.title} | Civitai Challenges`}
        description={
          challenge.description || `Participate in the ${challenge.title} challenge on Civitai`
        }
        links={[
          {
            href: `${env.NEXT_PUBLIC_BASE_URL as string}/challenges/${challenge.id}/${slugit(
              challenge.title
            )}`,
            rel: 'canonical',
          },
        ]}
      />
      <SensitiveShield contentNsfwLevel={challenge.nsfwLevel}>
        <Container size="xl" mb={{ base: 'md', sm: 32 }}>
          <Stack gap="xs" mb="xl">
            {/* Row 1: Title + context menu */}
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <Title fw="bold" lineClamp={2} order={1} fz={{ base: 'h2', sm: 'h1' }}>
                {challenge.title}
              </Title>
              <Group gap={4} wrap="nowrap" className="shrink-0">
                <ShareButton url={router.asPath} title={challenge.title}>
                  <ActionIcon variant="light" size="lg" color="gray">
                    <IconShare3 size={20} />
                  </ActionIcon>
                </ShareButton>
              {currentUser?.isModerator && (
                <Menu position="bottom-end" withArrow>
                  <Menu.Target>
                    <ActionIcon variant="light" size="lg">
                      <IconDotsVertical size={20} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Label>Actions</Menu.Label>
                    <Menu.Item
                      leftSection={<IconPencil size={14} stroke={1.5} />}
                      component={Link}
                      href={`/moderator/challenges/${challenge.id}/edit`}
                    >
                      Edit Challenge
                    </Menu.Item>
                    <ToggleLockComments entityId={challenge.id} entityType="challenge">
                      {({ toggle, locked, isLoading }) => (
                        <Menu.Item
                          leftSection={
                            isLoading ? <Loader size={14} /> : <IconLock size={14} stroke={1.5} />
                          }
                          onClick={toggle}
                          disabled={isLoading}
                          closeMenuOnClick={false}
                        >
                          {locked ? 'Unlock' : 'Lock'} Comments
                        </Menu.Item>
                      )}
                    </ToggleLockComments>

                    {isActive && (
                      <>
                        <Menu.Divider />
                        <Menu.Label>Quick Actions</Menu.Label>
                        <Menu.Item
                          leftSection={<IconTrophy size={14} />}
                          onClick={handleEndAndPickWinners}
                        >
                          End & Pick Winners
                        </Menu.Item>
                        <Menu.Item
                          leftSection={<IconX size={14} />}
                          color="red"
                          onClick={handleVoidChallenge}
                        >
                          Void Challenge
                        </Menu.Item>
                      </>
                    )}

                    {isScheduled && (
                      <>
                        <Menu.Divider />
                        <Menu.Label>Quick Actions</Menu.Label>
                        <Menu.Item
                          leftSection={<IconX size={14} />}
                          color="red"
                          onClick={handleVoidChallenge}
                        >
                          Cancel Challenge
                        </Menu.Item>
                      </>
                    )}

                    <Menu.Divider />
                    <Menu.Item
                      leftSection={<IconTrash size={14} />}
                      color="red"
                      onClick={handleDelete}
                    >
                      Delete
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              )}
              </Group>
            </Group>

            {/* Row 2: Theme + Status + Stats (inline with dividers) */}
            <Group gap={8} wrap="wrap">
              {/* Status badge */}
              {isCompleted ? (
                <IconBadge
                  size="lg"
                  radius="sm"
                  color="yellow.7"
                  icon={<IconTrophy size={16} fill="currentColor" />}
                >
                  Completed
                </IconBadge>
              ) : isActive ? (
                <IconBadge size="lg" radius="sm" color="green" icon={<IconSparkles size={16} />}>
                  Live
                </IconBadge>
              ) : isScheduled ? (
                <Badge size="lg" radius="sm" color="blue">
                  Upcoming
                </Badge>
              ) : null}

              {/* Countdown (active only) */}
              {isActive && (
                <IconBadge size="lg" radius="sm" icon={<IconClockHour4 size={18} />} color="gray">
                  <DaysFromNow date={challenge.endsAt} withoutSuffix />
                </IconBadge>
              )}

              {/* Entry count */}
              <IconBadge size="lg" radius="sm" icon={<IconPhoto size={18} />} color="gray">
                {abbreviateNumber(challenge.entryCount)}{' '}
                {challenge.entryCount === 1 ? 'entry' : 'entries'}
              </IconBadge>

              {challenge.theme && (
                <>
                  <Divider orientation="vertical" />
                  <IconBadge
                    size="lg"
                    radius="sm"
                    icon={<IconBulb size={18} />}
                    color="violet"
                    variant="light"
                  >
                    {challenge.theme}
                  </IconBadge>
                </>
              )}
            </Group>
          </Stack>

          <ContainerGrid2 gutter={{ base: 16, md: 32, lg: 64 }}>
            <ContainerGrid2.Col span={{ base: 12, md: 8 }}>
              <Stack gap="md">
                {/* Cover Image */}
                {challenge.coverImage && (
                  <div className="relative mx-auto max-w-2xl overflow-hidden rounded-lg">
                    <ImageGuard2 image={challenge.coverImage}>
                      {(safe) => (
                        <>
                          <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                          {safe ? (
                            <EdgeMedia2
                              src={challenge.coverImage!.url}
                              type={challenge.coverImage!.type}
                              className="aspect-[4/3] w-full object-cover"
                            />
                          ) : (
                            <div className="relative aspect-[4/3] w-full overflow-hidden">
                              <MediaHash {...challenge.coverImage} />
                            </div>
                          )}
                        </>
                      )}
                    </ImageGuard2>
                  </div>
                )}

                {/* About */}
                <article>
                  <Stack gap={4}>
                    {challenge.description ? (
                      <RenderHtml html={challenge.description} />
                    ) : (
                      <Text c="dimmed">No description provided.</Text>
                    )}
                  </Stack>
                </article>

                {/* Mobile CTA - shown after description on mobile only */}
                <MobileCTAInline challenge={challenge} />
              </Stack>
            </ContainerGrid2.Col>
            <ContainerGrid2.Col span={{ base: 12, md: 4 }}>
              <ChallengeSidebar challenge={challenge} />
            </ContainerGrid2.Col>
          </ContainerGrid2>
        </Container>

        {/* Winners Section (for completed challenges) */}
        {isCompleted && challenge.winners.length > 0 && <ChallengeWinners challenge={challenge} />}

        {/* Discussion Section */}
        <Container size="xl" id="comments" py={32}>
          <ChallengeDiscussion challengeId={challenge.id} userId={challenge.createdBy?.id} />
        </Container>

        {/* Entries Section */}
        <ChallengeEntries challenge={challenge} />
      </SensitiveShield>
    </>
  );
}

/** Card with a mouse-tracking white spotlight glow on the border. */
function SpotlightCard({
  children,
  borderColor,
  bg,
  ...rest
}: {
  children: React.ReactNode;
  borderColor: string;
  bg: string;
} & Omit<PaperProps, 'children'>) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [spotlight, setSpotlight] = useState({ x: 0, y: 0, opacity: 0 });

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setSpotlight({ x: e.clientX - rect.left, y: e.clientY - rect.top, opacity: 1 });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setSpotlight((s) => ({ ...s, opacity: 0 }));
  }, []);

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{
        position: 'relative',
        borderRadius: 'var(--mantine-radius-md)',
        '--spotlight-x': `${spotlight.x}px`,
        '--spotlight-y': `${spotlight.y}px`,
        '--spotlight-opacity': spotlight.opacity,
      } as React.CSSProperties}
    >
      {/* Border glow — wide, faint white bloom near cursor */}
      <div
        style={{
          position: 'absolute',
          inset: -1,
          borderRadius: 'inherit',
          background: `radial-gradient(400px circle at ${spotlight.x}px ${spotlight.y}px, rgba(255,255,255,0.04), transparent 70%)`,
          opacity: spotlight.opacity,
          transition: 'opacity 0.5s ease',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      <Paper
        p="md"
        radius="md"
        style={{
          position: 'relative',
          zIndex: 1,
          background: bg,
          border: `1px solid ${borderColor}`,
        }}
        {...rest}
      >
        {/* Wide ambient inner wash */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 'inherit',
            background: `radial-gradient(500px circle at ${spotlight.x}px ${spotlight.y}px, rgba(255,255,255,0.005), transparent 60%)`,
            opacity: spotlight.opacity,
            transition: 'opacity 0.5s ease',
            pointerEvents: 'none',
          }}
        />
        {children}
      </Paper>
    </div>
  );
}

function ChallengeSidebar({ challenge }: { challenge: ChallengeDetail }) {
  useInjectKeyframes();
  const colorScheme = useComputedColorScheme('dark');
  const cs = colorScheme; // shorthand for style helpers
  const router = useRouter();
  const currentUser = useCurrentUser();
  const isActive = challenge.status === ChallengeStatus.Active;
  const isDynamicPool =
    challenge.prizeMode === PrizeMode.Dynamic && challenge.buzzPerAction > 0;

  // Get user's entry count for this challenge
  const { data: userEntryData } = trpc.challenge.getUserEntryCount.useQuery(
    { challengeId: challenge.id },
    { enabled: !!currentUser && isActive }
  );
  const userEntryCount = userEntryData?.count ?? 0;

  // Get user's entries for paid review stats
  const { data: userEntryData2 } = trpc.challenge.getUserUnjudgedEntries.useQuery(
    { challengeId: challenge.id },
    { enabled: !!currentUser && isActive && userEntryCount > 0 }
  );
  const userEntries = userEntryData2?.entries;
  const hasFlatRatePurchase = userEntryData2?.hasFlatRatePurchase ?? false;
  // TODO: REMOVE — preview state toggle for mods (-1 = live/real data)
  const [previewState, setPreviewState] = useState<-1 | 0 | 1 | 2>(-1);
  const isPreview = previewState !== -1;
  // Real review data from API
  const realReviewedCount = userEntries?.filter((e) => e.reviewStatus !== 'pending').length ?? 0;
  const realUnreviewedCount = userEntries?.filter((e) => e.reviewStatus === 'pending').length ?? 0;
  // Mock overrides when previewing
  const previewData = isPreview ? PREVIEW_STATES[previewState as 0 | 1 | 2] : null;
  const reviewedCount = previewData?.reviewedCount ?? realReviewedCount;
  const unreviewedCount = previewData?.unreviewedCount ?? realUnreviewedCount;
  const totalEntries = previewData?.totalEntries ?? userEntryCount;
  const effectiveUserEntryCount = previewData?.userEntryCount ?? userEntryCount;
  const effectiveHasFlatRatePurchase = previewData?.hasFlatRatePurchase ?? hasFlatRatePurchase;
  const hasUserEntries = effectiveUserEntryCount > 0;
  // END preview state
  const totalPrizes = challenge.prizePool;
  const isFlatRate = challenge.reviewCostType === ChallengeReviewCostType.Flat;
  const guaranteeCost = isFlatRate ? challenge.reviewCost : unreviewedCount * challenge.reviewCost;
  const hasPaidReview =
    challenge.reviewCostType !== ChallengeReviewCostType.None && challenge.reviewCost > 0;
  const [buyHover, setBuyHover] = useState(false);
  const remainingSlots = challenge.maxEntriesPerUser - effectiveUserEntryCount;
  const reviewedPct = (reviewedCount / challenge.maxEntriesPerUser) * 100;
  const unreviewedPct = (unreviewedCount / challenge.maxEntriesPerUser) * 100;
  const submittedPct = (userEntryCount / challenge.maxEntriesPerUser) * 100;

  const queryUtils = trpc.useUtils();
  const requestReviewMutation = trpc.challenge.requestReview.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'All entries queued for guaranteed review!' });
      queryUtils.challenge.getUserUnjudgedEntries.invalidate({ challengeId: challenge.id });
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const challengeDetails: DescriptionTableProps['items'] = [
    {
      label: 'Starts',
      value: (
        <Text size="sm">{formatDate(challenge.startsAt, 'MMM DD, YYYY hh:mm A [UTC]', true)}</Text>
      ),
    },
    {
      label: 'Ends',
      value: (
        <Text size="sm">{formatDate(challenge.endsAt, 'MMM DD, YYYY hh:mm A [UTC]', true)}</Text>
      ),
    },
    {
      label: 'Max Entries',
      value: <Text size="sm">{challenge.maxEntriesPerUser} per user</Text>,
    },
    {
      label: 'AI Reviews',
      value: <Text size="sm">Only 6–12 entries selected at random every 10 min</Text>,
    },
    ...(challenge.entryPrize && challenge.entryPrizeRequirement > 0
      ? [
          {
            label: 'Participation Prize Requirement',
            value: <Text size="sm">Min {challenge.entryPrizeRequirement} entries to qualify</Text>,
          },
        ]
      : []),
    ...(challenge.allowedNsfwLevel > 0
      ? [
          {
            label: 'Allowed Ratings',
            value: (
              <Group gap={4}>
                {parseBitwiseBrowsingLevel(challenge.allowedNsfwLevel).map((level) => (
                  <Badge key={level} size="sm" color={nsfwLevelColors[level]} variant="filled">
                    {browsingLevelLabels[level as keyof typeof browsingLevelLabels]}
                  </Badge>
                ))}
              </Group>
            ),
          },
        ]
      : []),
  ];

  // Prize breakdown
  const prizeItems: DescriptionTableProps['items'] = challenge.prizes.map((prize, index) => ({
    label: (
      <Group gap={4}>
        <ThemeIcon
          size="sm"
          color={index === 0 ? 'yellow' : index === 1 ? 'gray.4' : 'orange.7'}
          variant="light"
        >
          <IconTrophy size={14} />
        </ThemeIcon>
        <Text size="sm">{getPlaceLabel(index + 1)}</Text>
      </Group>
    ),
    value: (
      <CurrencyBadge
        size="sm"
        currency={Currency.BUZZ}
        unitAmount={prize.buzz}
        variant="transparent"
      />
    ),
  }));

  // Shared props for DescriptionTable inside accordion panels (no outer borders)
  const accordionTableProps = {
    withBorder: true,
    paperProps: {
      style: { borderLeft: 0, borderRight: 0, borderBottom: 0 },
      radius: 0,
    },
  } as const;

  if (challenge.entryPrize) {
    prizeItems.push({
      label: (
        <Group gap={4}>
          <ThemeIcon size="sm" color="blue" variant="light">
            <IconGift size={14} />
          </ThemeIcon>
          <Text size="sm">Participation</Text>
        </Group>
      ),
      value: (
        <CurrencyBadge
          size="sm"
          currency={Currency.BUZZ}
          type="blue"
          unitAmount={challenge.entryPrize.buzz}
          variant="transparent"
        />
      ),
    });
  }

  return (
    <Stack gap="md">
      {/* Combined Dynamic Prize Pool + Entries Card */}
      {isDynamicPool && (
        <SpotlightCard
          borderColor="transparent"
          bg="transparent"
          p={0}
          style={{ overflow: 'hidden' }}
        >
          {/* TODO: REMOVE — preview state toggle (mod only) */}
          {currentUser?.isModerator && (
            <Group
              justify="space-between"
              px="xs"
              py={4}
              style={{
                background: 'rgba(128,128,128,0.1)',
                border: '1px dashed rgba(128,128,128,0.3)',
                borderRadius: 'var(--mantine-radius-sm) var(--mantine-radius-sm) 0 0',
              }}
            >
              <Text size="xs" fw={500}>Preview:</Text>
              <Group gap={4}>
                {([
                  { key: -1, label: 'Live', color: 'green' },
                  { key: 0, label: 'No entries', color: 'blue' },
                  { key: 1, label: 'Has entries', color: 'blue' },
                  { key: 2, label: 'Paid', color: 'blue' },
                ] as const).map(({ key, label, color }) => (
                  <Badge
                    key={key}
                    size="xs"
                    variant={previewState === key ? 'filled' : 'light'}
                    color={previewState === key ? color : 'gray'}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setPreviewState(key as -1 | 0 | 1 | 2)}
                  >
                    {label}
                  </Badge>
                ))}
              </Group>
            </Group>
          )}
          {/* END preview toggle */}

          {/* ── Green top: Growing Prize Pool ── */}
          <div
            style={{
              borderTop: getBorder(cs, 'teal'),
              borderLeft: getBorder(cs, 'teal'),
              borderRight: getBorder(cs, 'teal'),
              background: getBackground(cs, 'teal'),
            }}
          >
            <Stack gap="sm" align="center" p="md">
              <Group gap={6} justify="center">
                <ThemeIcon variant="light" color="teal" size="sm" radius="xl">
                  <IconTrendingUp size={14} />
                </ThemeIcon>
                <Text size="sm" fw={700} tt="uppercase" lts={0.5}>
                  Growing Prize Pool
                </Text>
              </Group>

              <Group gap={6} justify="center" align="baseline">
                <CurrencyIcon currency="BUZZ" size={28} />
                <Text
                  fw={900}
                  style={{
                    fontSize: '2rem',
                    lineHeight: 1.1,
                    background:
                      cs === 'dark'
                        ? 'linear-gradient(135deg, #6ee7b7 0%, #34d399 30%, #10b981 60%, #34d399 100%)'
                        : 'linear-gradient(135deg, #059669 0%, #10b981 30%, #34d399 60%, #10b981 100%)',
                    backgroundSize: '200% auto',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    animation: 'prize-shimmer 4s linear infinite',
                  }}
                >
                  {challenge.prizePool.toLocaleString()}
                </Text>
              </Group>

              <Badge
                size="lg"
                variant="light"
                color="teal"
                leftSection={<IconTrendingUp size={14} />}
                style={{ animation: 'prize-pulse 3s ease-in-out infinite' }}
              >
                +{challenge.buzzPerAction} Buzz per{' '}
                {challenge.poolTrigger === PoolTrigger.User ? 'participant' : 'entry'}
              </Badge>

              {challenge.maxPrizePool && challenge.maxPrizePool > 0 && (
                <Stack gap={4} w="100%">
                  <Progress
                    value={Math.min(
                      (challenge.prizePool / challenge.maxPrizePool) * 100,
                      100
                    )}
                    color="teal"
                    size="sm"
                    radius="xl"
                  />
                  <Text size="xs" c="dimmed" ta="center">
                    {Math.round((challenge.prizePool / challenge.maxPrizePool) * 100)}% to{' '}
                    {challenge.maxPrizePool.toLocaleString()} max
                  </Text>
                </Stack>
              )}

              <Text size="sm" ta="center">
                Every{' '}
                {challenge.poolTrigger === PoolTrigger.User ? 'new participant' : 'entry'} adds{' '}
                <Text span fw={700} c="teal.5">
                  {challenge.buzzPerAction.toLocaleString()} Buzz
                </Text>{' '}
                to the prize pool. Enter now to make the prize bigger for everyone!
              </Text>
            </Stack>
          </div>

          {/* ── Your Entries section ── */}
          <div
            style={{
              position: 'relative',
              borderTop: getBorder(cs, 'teal'),
              borderLeft: getBorder(cs, hasUserEntries ? 'yellow' : 'gray'),
              borderRight: getBorder(cs, hasUserEntries ? 'yellow' : 'gray'),
              background: hasUserEntries ? getBackground(cs, 'yellow') : getBackground(cs, 'neutral'),
              boxShadow: getShadow(cs, 'large'),
            }}
          >
            <GlowDivider variant="teal" />
            <Stack gap="sm" p="md">
              <Group justify="space-between" align="center">
                <Text size="sm" fw={700}>
                  Your Entries
                </Text>
                <Badge
                  size="sm"
                  variant="light"
                  color={reviewedCount > 0 ? 'yellow' : 'gray'}
                >
                  {reviewedCount}/{totalEntries} reviewed
                </Badge>
              </Group>

              <Progress.Root
                size="lg"
                radius="xl"
                style={{ boxShadow: getShadow(cs, 'small') }}
              >
                {reviewedCount > 0 && (
                  <Progress.Section value={reviewedPct} color="green" />
                )}
                {unreviewedCount > 0 && (
                  <Progress.Section
                    value={unreviewedPct}
                    color={buyHover ? undefined : 'orange'}
                    style={
                      buyHover
                        ? {
                            background:
                              'linear-gradient(to right, var(--mantine-color-green-6) 50%, var(--mantine-color-orange-6) 50%)',
                            backgroundSize: '200% 100%',
                            animation: 'sweep-fill-pulse 2s ease-in-out infinite',
                          }
                        : undefined
                    }
                  />
                )}
              </Progress.Root>
              <Group gap={8}>
                {reviewedCount > 0 && (
                  <ProgressLegendDot color="green" count={reviewedCount} label="reviewed" />
                )}
                {unreviewedCount > 0 && (
                  <ProgressLegendDot
                    color="orange"
                    count={unreviewedCount}
                    label={buyHover ? 'could be reviewed' : 'pending'}
                    dynamicColor={buyHover ? 'var(--mantine-color-green-6)' : undefined}
                  />
                )}
                {remainingSlots > 0 && (
                  <ProgressLegendDot color="gray" count={remainingSlots} label="remaining" />
                )}
              </Group>

              {/* All entries reviewed — congrats message */}
              {hasUserEntries && unreviewedCount === 0 && reviewedCount > 0 && (
                <Group gap={6} justify="center" py={4}>
                  <ThemeIcon variant="light" color="yellow" size="sm" radius="xl">
                    <IconCheck size={12} />
                  </ThemeIcon>
                  <Text size="xs" c="yellow.5" fw={500}>
                    All entries guaranteed a review — you{'\u2019'}re in it to win it!
                  </Text>
                </Group>
              )}

              {/* Review text + button when user has unreviewed entries */}
              {hasUserEntries && unreviewedCount > 0 && !effectiveHasFlatRatePurchase && hasPaidReview && (
                <>
                  <Text size="xs">
                    Only reviewed entries compete for the prize pool. Don&apos;t leave it to
                    chance. Guarantee all your entries get reviewed!
                  </Text>

                  <Stack gap={4}>
                    {!isFlatRate && (
                      <Text size="xs" c="dimmed" ta="center">
                        {challenge.reviewCost} Buzz per entry {'\u00b7'} {unreviewedCount}{' '}
                        {unreviewedCount === 1 ? 'entry' : 'entries'}
                      </Text>
                    )}
                    <div
                      onMouseEnter={() => setBuyHover(true)}
                      onMouseLeave={() => setBuyHover(false)}
                    >
                      <BuzzTransactionButton
                        buzzAmount={guaranteeCost}
                        onPerformTransaction={() => {
                          if (isFlatRate) {
                            requestReviewMutation.mutate({ challengeId: challenge.id });
                          } else {
                            const imageIds = (userEntries ?? [])
                              .filter((e) => e.reviewStatus === 'pending')
                              .map((e) => e.imageId);
                            requestReviewMutation.mutate({
                              challengeId: challenge.id,
                              imageIds,
                            });
                          }
                        }}
                        loading={requestReviewMutation.isPending}
                        label={
                          isFlatRate
                            ? 'Review All My Entries'
                            : `Guarantee ${
                                unreviewedCount === 1
                                  ? '1 Review'
                                  : `All ${unreviewedCount} Reviews`
                              }`
                        }
                        showPurchaseModal
                        color="yellow.6"
                        fullWidth
                      />
                    </div>
                  </Stack>
                </>
              )}
            </Stack>
          </div>

          {/* ── Gray bottom: Generate + Submit ── */}
          {isActive && !currentUser?.muted && (
            <div
              style={{
                position: 'relative',
                borderTop: getBorder(cs, hasUserEntries ? 'yellow' : 'gray'),
                borderLeft: getBorder(cs, 'gray'),
                borderRight: getBorder(cs, 'gray'),
                borderBottom: getBorder(cs, 'gray'),
                background: getBackground(cs, 'neutral'),
                borderRadius: '0 0 var(--mantine-radius-md) var(--mantine-radius-md)',
                padding: 'var(--mantine-spacing-md)',
                boxShadow: getShadow(cs, 'large'),
              }}
            >
              <GlowDivider variant={hasUserEntries ? 'yellow' : 'gray'} />
              <Group gap={8} wrap="nowrap">
                <Button
                  onClick={() => openChallengeGenerator(challenge.modelVersionIds)}
                  leftSection={<IconBrush size={16} />}
                  variant="filled"
                  color="blue"
                  fullWidth
                >
                  Generate
                </Button>
                {challenge.collectionId && (
                  <LoginRedirect reason="submit-challenge">
                    <Button
                      onClick={() => {
                        dialogStore.trigger({
                          component: ChallengeSubmitModal,
                          props: {
                            challengeId: challenge.id,
                            collectionId: challenge.collectionId!,
                          },
                        });
                      }}
                      leftSection={<IconPhoto size={16} />}
                      variant="light"
                      color="blue"
                      fullWidth
                    >
                      Submit
                    </Button>
                  </LoginRedirect>
                )}
              </Group>
            </div>
          )}
        </SpotlightCard>
      )}

      {/* Action buttons - shown when NOT dynamic pool; hidden on mobile */}
      {!isDynamicPool && (
        <Group gap={8} wrap="nowrap" visibleFrom="md">
          {isActive && !currentUser?.muted ? (
            <>
              <Button
                onClick={() => openChallengeGenerator(challenge.modelVersionIds)}
                leftSection={<IconBrush size={16} />}
                variant="filled"
                color="blue"
                fullWidth
              >
                Generate
              </Button>
              {challenge.collectionId && (
                <LoginRedirect reason="submit-challenge">
                  <Button
                    onClick={() => {
                      dialogStore.trigger({
                        component: ChallengeSubmitModal,
                        props: { challengeId: challenge.id, collectionId: challenge.collectionId! },
                      });
                    }}
                    leftSection={<IconPhoto size={16} />}
                    variant="light"
                    color="blue"
                    fullWidth
                  >
                    Submit
                  </Button>
                </LoginRedirect>
              )}
            </>
          ) : challenge.status === ChallengeStatus.Completed ? (
            <Group
              gap="xs"
              justify="center"
              py="xs"
              px="md"
              style={{
                flex: 1,
                borderRadius: 'var(--mantine-radius-sm)',
                background:
                  colorScheme === 'dark'
                    ? 'linear-gradient(135deg, rgba(250,176,5,0.12) 0%, rgba(250,176,5,0.04) 100%)'
                    : 'linear-gradient(135deg, rgba(250,176,5,0.15) 0%, rgba(250,176,5,0.05) 100%)',
                border: `1px solid ${
                  colorScheme === 'dark' ? 'rgba(250,176,5,0.25)' : 'rgba(250,176,5,0.35)'
                }`,
              }}
            >
              <ThemeIcon variant="transparent" color="yellow.5" size="sm">
                <IconTrophy size={18} fill="currentColor" />
              </ThemeIcon>
              <Text size="sm" fw={600} c="yellow.5" tt="uppercase" lts={1}>
                Challenge Completed
              </Text>
            </Group>
          ) : null}
        </Group>
      )}

      <Accordion
        variant="separated"
        multiple
        defaultValue={['details', 'models', 'prizes']}
        styles={(theme) => ({
          content: { padding: 0 },
          item: {
            overflow: 'hidden',
            borderColor: colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3],
            boxShadow: theme.shadows.sm,
          },
          control: {
            padding: theme.spacing.sm,
          },
        })}
      >
        <Accordion.Item value="details">
          <Accordion.Control>
            <Group justify="space-between">Overview</Group>
          </Accordion.Control>
          <Accordion.Panel>
            <DescriptionTable items={challengeDetails} labelWidth="40%" {...accordionTableProps} />
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="prizes">
          <Accordion.Control>
            <Group justify="space-between">Prizes</Group>
          </Accordion.Control>
          <Accordion.Panel>
            <ScrollArea.Autosize mah={300}>
              <DescriptionTable items={prizeItems} labelWidth="50%" {...accordionTableProps} />
            </ScrollArea.Autosize>
          </Accordion.Panel>
        </Accordion.Item>

        {challenge.models.length > 0 && (
          <Accordion.Item value="models">
            <Accordion.Control>
              <Group justify="space-between">Eligible Models</Group>
            </Accordion.Control>
            <Accordion.Panel>
              <ScrollArea.Autosize mah={300}>
                {challenge.models.map((m) => (
                  <div
                    key={m.versionId}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-gray-1 dark:hover:bg-dark-5"
                  >
                    <Link
                      href={`/models/${m.id}?modelVersionId=${m.versionId}`}
                      className="flex min-w-0 flex-1 items-center gap-3 no-underline"
                      target="_blank"
                    >
                      {m.image ? (
                        <ImageGuard2 image={m.image} explain={false}>
                          {(safe) => (
                            <div className="relative size-12 shrink-0 overflow-hidden rounded-lg bg-gray-2 dark:bg-dark-3">
                              {safe ? (
                                <EdgeMedia2
                                  src={m.image!.url}
                                  width={96}
                                  type={m.image!.type}
                                  className="size-full object-cover"
                                />
                              ) : (
                                <MediaHash {...m.image!} />
                              )}
                            </div>
                          )}
                        </ImageGuard2>
                      ) : (
                        <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-gray-2 dark:bg-dark-3">
                          <IconCube size={20} className="text-dimmed" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <Text size="sm" fw={500} lineClamp={1}>
                          {m.name}
                        </Text>
                        <Group gap={4} wrap="nowrap">
                          <Badge size="xs" variant="light">
                            {m.baseModel}
                          </Badge>
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {m.versionName}
                          </Text>
                        </Group>
                      </div>
                    </Link>
                    {isActive && (
                      <ActionIcon
                        variant="subtle"
                        color="blue"
                        size="md"
                        onClick={() => {
                          generationPanel.open({ type: 'modelVersion', id: m.versionId });
                          generationFormStore.setType('image');
                        }}
                        aria-label={`Generate with ${m.name}`}
                      >
                        <IconBrush size={16} />
                      </ActionIcon>
                    )}
                  </div>
                ))}
              </ScrollArea.Autosize>
            </Accordion.Panel>
          </Accordion.Item>
        )}
      </Accordion>

      <CreatorCardSimple
        user={{
          ...challenge.createdBy,
          // Convert null to undefined for CreatorCardSimple compatibility
          cosmetics: challenge.createdBy.cosmetics ?? undefined,
          profilePicture: challenge.createdBy.profilePicture ?? undefined,
        }}
        statDisplayOverwrite={[]}
      />
    </Stack>
  );
}

function ChallengeWinners({ challenge }: { challenge: ChallengeDetail }) {
  const colorScheme = useComputedColorScheme('dark');
  const isDark = colorScheme === 'dark';

  // Reorder winners for podium display: [2nd, 1st, 3rd]
  const podiumOrder = [
    challenge.winners.find((w) => w.place === 2),
    challenge.winners.find((w) => w.place === 1),
    challenge.winners.find((w) => w.place === 3),
  ].filter(Boolean) as ChallengeDetail['winners'];

  return (
    <div
      className="relative overflow-hidden py-12"
      style={{
        background: isDark
          ? 'linear-gradient(180deg, rgba(250, 176, 5, 0.15) 0%, rgba(250, 176, 5, 0.05) 100%)'
          : 'linear-gradient(180deg, rgba(250, 176, 5, 0.2) 0%, rgba(250, 176, 5, 0.05) 100%)',
      }}
    >
      {/* Decorative elements */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-20 -top-20 size-40 rounded-full bg-yellow-500/10 blur-3xl" />
        <div className="absolute -right-20 top-1/2 size-60 rounded-full bg-orange-500/10 blur-3xl" />
      </div>

      <Container size="xl" className="relative">
        <Stack gap="xl">
          {/* Header */}
          <div className="text-center">
            <Group justify="center" gap="sm" mb="xs">
              <IconTrophy size={32} className="text-yellow-500" />
              <Title order={2}>Challenge Winners</Title>
              <IconTrophy size={32} className="text-yellow-500" />
            </Group>
          </div>

          {/* Podium Layout - Desktop: 2nd | 1st (elevated) | 3rd */}
          <div className="hidden md:block">
            <div className="flex items-end justify-center gap-4">
              {podiumOrder.map((winner, index) => (
                <WinnerPodiumCard
                  key={winner.place}
                  winner={winner}
                  isFirst={index === 1}
                  className={index === 1 ? 'z-10' : ''}
                />
              ))}
            </div>
          </div>

          {/* Mobile Layout - Stacked with 1st on top */}
          <div className="md:hidden">
            <Stack gap="md">
              {challenge.winners
                .sort((a, b) => a.place - b.place)
                .map((winner) => (
                  <WinnerPodiumCard
                    key={winner.place}
                    winner={winner}
                    isFirst={winner.place === 1}
                    isMobile
                  />
                ))}
            </Stack>
          </div>

          {/* Judge's Commentary Section */}
          {(challenge.completionSummary?.judgingProcess ||
            challenge.completionSummary?.outcome) && (
            <div
              className={`mt-4 rounded-xl border p-6 ${
                isDark ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-white/80'
              }`}
            >
              {challenge.judge && (
                <Group gap="sm" mb="md">
                  <UserAvatar
                    user={{
                      id: challenge.judge.userId,
                      profilePicture: challenge.judge.profilePicture ?? undefined,
                      cosmetics: challenge.judge.cosmetics ?? undefined,
                    }}
                    size="md"
                  />
                  <div>
                    <Text fw={600} size="sm">
                      {challenge.judge.name}&apos;s Commentary
                    </Text>
                  </div>
                </Group>
              )}
              {!challenge.judge && (
                <Text fw={600} size="sm" mb="md">
                  Judging Commentary
                </Text>
              )}

              <Stack gap="md">
                {challenge.completionSummary?.judgingProcess && (
                  <div>
                    <Text size="xs" fw={600} c="dimmed" mb={4}>
                      Judging Process
                    </Text>
                    <Spoiler maxHeight={120} showLabel="Show more" hideLabel="Show less">
                      <div className="text-sm">
                        <CustomMarkdown>
                          {challenge.completionSummary.judgingProcess}
                        </CustomMarkdown>
                      </div>
                    </Spoiler>
                  </div>
                )}

                {challenge.completionSummary?.outcome && (
                  <div>
                    <Text size="xs" fw={600} c="dimmed" mb={4}>
                      Final Verdict
                    </Text>
                    <Spoiler maxHeight={80} showLabel="Show more" hideLabel="Show less">
                      <div className="text-sm">
                        <CustomMarkdown>{challenge.completionSummary.outcome}</CustomMarkdown>
                      </div>
                    </Spoiler>
                  </div>
                )}
              </Stack>
            </div>
          )}
        </Stack>
      </Container>
    </div>
  );
}

const placeConfig = {
  1: {
    label: '1st Place',
    gradient: 'from-yellow-400 via-amber-500 to-orange-500',
    border: 'border-yellow-500/50',
    icon: IconCrown,
    iconColor: 'text-yellow-500',
    bgGlow: 'shadow-yellow-500/20',
  },
  2: {
    label: '2nd Place',
    gradient: 'from-slate-300 via-gray-400 to-slate-500',
    border: 'border-slate-400/50',
    icon: IconTrophy,
    iconColor: 'text-slate-400',
    bgGlow: 'shadow-slate-500/20',
  },
  3: {
    label: '3rd Place',
    gradient: 'from-amber-600 via-orange-700 to-amber-800',
    border: 'border-orange-700/50',
    icon: IconTrophy,
    iconColor: 'text-orange-700',
    bgGlow: 'shadow-orange-700/20',
  },
} as const;

function WinnerPodiumCard({
  winner,
  isFirst,
  className = '',
  isMobile = false,
}: {
  winner: ChallengeDetail['winners'][number];
  isFirst: boolean;
  className?: string;
  isMobile?: boolean;
}) {
  const [reasonExpanded, setReasonExpanded] = useState(false);
  const colorScheme = useComputedColorScheme('dark');
  const isDark = colorScheme === 'dark';
  const config = placeConfig[winner.place as 1 | 2 | 3] ?? placeConfig[3];
  const PlaceIcon = config.icon;

  // Mobile: full width; Desktop: fixed widths for podium effect
  const widthClass = isMobile ? 'w-full' : isFirst ? 'w-80' : 'w-64';

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-xl border-2 ${config.border} ${
        isDark ? 'bg-dark-6' : 'bg-white'
      } ${widthClass} ${isFirst ? 'shadow-xl' : ''} ${config.bgGlow} shadow-lg ${className}`}
    >
      {/* Place Header with Gradient */}
      <div className={`bg-gradient-to-r ${config.gradient} px-4 py-2.5`}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Group gap={6} wrap="nowrap">
            <PlaceIcon size={isMobile ? 20 : isFirst ? 24 : 18} className="text-white" />
            <Text
              fw={700}
              c="white"
              size={isMobile || isFirst ? 'md' : 'sm'}
              className="whitespace-nowrap"
            >
              {config.label}
            </Text>
          </Group>
          <CurrencyBadge
            currency={Currency.BUZZ}
            unitAmount={winner.buzzAwarded}
            size="sm"
            style={{ background: 'rgba(255,255,255,0.2)', color: 'white' }}
          />
        </Group>
      </div>

      {/* Winner Image */}
      {winner.imageUrl && (
        <Link href={`/images/${winner.imageId}`}>
          <div
            className={`relative w-full overflow-hidden ${
              isFirst ? 'aspect-square' : 'aspect-[4/3]'
            }`}
            style={{ cursor: 'pointer' }}
          >
            <EdgeMedia2
              src={winner.imageUrl}
              type={MediaType.image}
              width={450}
              className="size-full object-cover transition-transform duration-300 hover:scale-105"
            />
            {winner.judgeScore && (
              <div className="absolute left-2 top-2">
                <JudgeScoreBadge score={winner.judgeScore} />
              </div>
            )}
          </div>
        </Link>
      )}

      {/* Winner Info */}
      <div className="flex flex-1 flex-col gap-3 p-4">
        {/* Username + Avatar */}
        <Link href={`/user/${winner.username}`}>
          <Group gap="xs">
            <UserAvatar
              user={{
                id: winner.userId,
                username: winner.username,
                profilePicture: winner.profilePicture ?? undefined,
                cosmetics: winner.cosmetics ?? undefined,
              }}
              size="sm"
              includeAvatar
              withUsername={false}
            />
            <Text fw={600} size={isFirst ? 'md' : 'sm'} className="hover:underline">
              {winner.username}
            </Text>
            {isFirst && <IconCrown size={16} className={config.iconColor} />}
          </Group>
        </Link>

        {/* Judge's Reason */}
        {winner.reason && (
          <div
            className={`rounded-lg p-3 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}
            style={{ borderLeft: `3px solid var(--mantine-color-blue-5)` }}
          >
            <Text size="xs" c="dimmed" mb={4}>
              <IconSparkles size={12} className="mr-1 inline" />
              Judge&apos;s Note
            </Text>
            <Text
              size="xs"
              style={{ fontStyle: 'italic', lineHeight: 1.6 }}
              lineClamp={reasonExpanded ? undefined : 3}
            >
              &ldquo;{winner.reason}&rdquo;
            </Text>
            {winner.reason.length > 120 && (
              <Text
                size="xs"
                c="blue"
                className="mt-2 cursor-pointer hover:underline"
                onClick={() => setReasonExpanded(!reasonExpanded)}
              >
                {reasonExpanded ? 'Show less' : 'Read full note'}
              </Text>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ChallengeEntries({ challenge }: { challenge: ChallengeDetail }) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const currentUser = useCurrentUser();
  const mobile = useIsMobile();

  const [judgeReviewedOnly, setJudgeReviewedOnly] = useState(false);
  const [myEntriesOnly, setMyEntriesOnly] = useState(false);
  const [opened, setOpened] = useState(false);
  const isActive = challenge.status === ChallengeStatus.Active;
  const hasCollection = !!challenge.collectionId;
  const displaySubmitAction = isActive && hasCollection && !currentUser?.muted;

  const filterCount = (judgeReviewedOnly ? 1 : 0) + (myEntriesOnly ? 1 : 0);

  const judgeInfo = useMemo(
    () =>
      challenge.judge
        ? {
            userId: challenge.judge.userId,
            username: challenge.judge.name,
            profilePicture: challenge.judge.profilePicture,
          }
        : undefined,
    [challenge.judge]
  );

  const handleOpenSubmitModal = () => {
    if (challenge.collectionId) {
      dialogStore.trigger({
        component: ChallengeSubmitModal,
        props: { challengeId: challenge.id, collectionId: challenge.collectionId },
      });
    }
  };

  const hasAnyFilter = !!challenge.judgedTagId || !!currentUser;

  const filterTarget = hasAnyFilter ? (
    <Indicator
      offset={4}
      label={filterCount ? filterCount : undefined}
      size={14}
      zIndex={10}
      disabled={!filterCount}
      inline
    >
      <FilterButton icon={IconFilter} onClick={() => setOpened((o) => !o)} active={opened}>
        Filters
      </FilterButton>
    </Indicator>
  ) : null;

  const filterDropdown = (
    <Stack gap={8} p="md">
      <Stack gap={0}>
        <Divider label="Modifiers" className="text-sm font-bold" mb={4} />
        <Group gap={8} mb={4}>
          <FilterChip checked={judgeReviewedOnly} onChange={() => setJudgeReviewedOnly((v) => !v)}>
            <span>Judge Reviewed</span>
          </FilterChip>
          <FilterChip checked={myEntriesOnly} onChange={() => setMyEntriesOnly((v) => !v)}>
            <span>My Entries</span>
          </FilterChip>
        </Group>
      </Stack>

      {filterCount > 0 && (
        <Button
          color="gray"
          variant={colorScheme === 'dark' ? 'filled' : 'light'}
          onClick={() => {
            setJudgeReviewedOnly(false);
            setMyEntriesOnly(false);
          }}
          fullWidth
        >
          Clear all filters
        </Button>
      )}
    </Stack>
  );

  const filterMenu = hasAnyFilter ? (
    <IsClient>
      {mobile ? (
        <>
          {filterTarget}
          <Drawer
            opened={opened}
            onClose={() => setOpened(false)}
            size="90%"
            position="bottom"
            styles={{
              content: {
                height: 'auto',
                maxHeight: 'calc(100dvh - var(--header-height))',
              },
              body: { padding: 0, overflowY: 'auto' },
              header: { padding: '4px 8px' },
              close: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
            }}
          >
            {filterDropdown}
          </Drawer>
        </>
      ) : (
        <Popover
          zIndex={200}
          position="bottom-end"
          shadow="md"
          onClose={() => setOpened(false)}
          middlewares={{ flip: true, shift: true }}
          withinPortal
          withArrow
        >
          <Popover.Target>{filterTarget}</Popover.Target>
          <Popover.Dropdown maw={468} p={0} w="100%">
            <ScrollArea.Autosize mah="calc(90vh - var(--header-height) - 56px)" type="hover">
              {filterDropdown}
            </ScrollArea.Autosize>
          </Popover.Dropdown>
        </Popover>
      )}
    </IsClient>
  ) : null;

  return (
    <Container
      fluid
      my="md"
      style={{
        background: colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1],
      }}
    >
      <MasonryProvider columnWidth={appConstants.cardSizes.image} maxSingleColumnWidth={450}>
        <MasonryContainer>
          <Stack gap="md" py={32}>
            <Group wrap="wrap" justify="space-between">
              <Group wrap="wrap">
                <Title order={2}>Entries</Title>
                <Text c="dimmed" size="sm">
                  {challenge.entryCount.toLocaleString()} total{' '}
                  {challenge.entryCount === 1 ? 'entry' : 'entries'}
                </Text>
              </Group>
              <Group gap="xs">
                {filterMenu}
                {displaySubmitAction && (
                  <>
                    <Button
                      size="sm"
                      variant="filled"
                      onClick={() => openChallengeGenerator(challenge.modelVersionIds)}
                      leftSection={<IconBrush size={16} />}
                    >
                      Generate Entries
                    </Button>
                    <LoginRedirect reason="submit-challenge">
                      <Button
                        size="sm"
                        variant="light"
                        onClick={handleOpenSubmitModal}
                        leftSection={<IconPhoto size={16} />}
                      >
                        Submit Entries
                      </Button>
                    </LoginRedirect>
                  </>
                )}
              </Group>
            </Group>

            {challenge.entryCount === 0 || !hasCollection ? (
              <NoContent
                message={
                  isActive
                    ? 'No entries yet. Be the first to submit!'
                    : 'No entries for this challenge.'
                }
              />
            ) : (
              <ImagesInfinite
                filters={{
                  collectionId: challenge.collectionId ?? undefined,
                  collectionTagId: judgeReviewedOnly
                    ? challenge.judgedTagId ?? undefined
                    : undefined,
                  userId: myEntriesOnly ? currentUser?.id : undefined,
                  period: 'AllTime',
                  sort: ImageSort.Random,
                }}
                disableStoreFilters
                judgeInfo={judgeInfo}
              />
            )}
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Container>
  );
}

function MobileCTAInline({ challenge }: { challenge: ChallengeDetail }) {
  const currentUser = useCurrentUser();
  const isActive = challenge.status === ChallengeStatus.Active;

  const isDynamicPool =
    challenge.prizeMode === PrizeMode.Dynamic && challenge.buzzPerAction > 0;

  if (!isActive || currentUser?.muted || isDynamicPool) return null;

  return (
    <Stack gap="xs" hiddenFrom="md" mt="md">
      <Button
        onClick={() => openChallengeGenerator(challenge.modelVersionIds)}
        leftSection={<IconBrush size={16} />}
        variant="filled"
        color="blue"
        fullWidth
      >
        Generate Entries
      </Button>
      {challenge.collectionId && (
        <LoginRedirect reason="submit-challenge">
          <Button
            onClick={() => {
              dialogStore.trigger({
                component: ChallengeSubmitModal,
                props: { challengeId: challenge.id, collectionId: challenge.collectionId! },
              });
            }}
            leftSection={<IconPhoto size={16} />}
            variant="light"
            color="blue"
            fullWidth
          >
            Submit Entries
          </Button>
        </LoginRedirect>
      )}
    </Stack>
  );
}

function getPlaceLabel(place: number): string {
  switch (place) {
    case 1:
      return '1st Place';
    case 2:
      return '2nd Place';
    case 3:
      return '3rd Place';
    default:
      return `${place}th Place`;
  }
}

export default Page(ChallengeDetailsPage);
