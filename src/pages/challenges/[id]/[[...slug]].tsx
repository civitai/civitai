import {
  Accordion,
  ActionIcon,
  Badge,
  Button,
  Container,
  Divider,
  Group,
  Menu,
  ScrollArea,
  Spoiler,
  Stack,
  Text,
  ThemeIcon,
  Title,
  useMantineTheme,
  useComputedColorScheme,
} from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next';
import { useState } from 'react';
import * as z from 'zod';

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
import { Currency, ChallengeStatus } from '~/shared/utils/prisma/enums';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import {
  IconBrush,
  IconBulb,
  IconClockHour4,
  IconCrown,
  IconCube,
  IconDotsVertical,
  IconGift,
  IconPencil,
  IconPhoto,
  IconShare3,
  IconSparkles,
  IconTrash,
  IconTrophy,
  IconX,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { useQueryChallenge } from '~/components/Challenge/challenge.utils';
import type { Props as DescriptionTableProps } from '~/components/DescriptionTable/DescriptionTable';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { slugit } from '~/utils/string-helpers';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
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
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { constants as appConstants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { ChallengeDiscussion } from '~/components/Challenge/ChallengeDiscussion';

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

              {/* Allowed content ratings */}
              {challenge.allowedNsfwLevel > 0 && (
                <>
                  <Divider orientation="vertical" />
                  <Group gap={4}>
                    <Text size="xs" c="dimmed">
                      Allowed Ratings:
                    </Text>
                    {parseBitwiseBrowsingLevel(challenge.allowedNsfwLevel).map((level) => (
                      <Badge key={level} size="sm" color={nsfwLevelColors[level]} variant="filled">
                        {browsingLevelLabels[level as keyof typeof browsingLevelLabels]}
                      </Badge>
                    ))}
                  </Group>
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
                      <ContentClamp maxHeight={300}>
                        <RenderHtml html={challenge.description} />
                      </ContentClamp>
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

function ChallengeSidebar({ challenge }: { challenge: ChallengeDetail }) {
  const colorScheme = useComputedColorScheme('dark');
  const router = useRouter();
  const currentUser = useCurrentUser();

  const isActive = challenge.status === ChallengeStatus.Active;

  // Get user's entry count for this challenge
  const { data: userEntryData } = trpc.challenge.getUserEntryCount.useQuery(
    { challengeId: challenge.id },
    { enabled: !!currentUser && isActive }
  );
  const userEntryCount = userEntryData?.count ?? 0;

  const challengeDetails: DescriptionTableProps['items'] = [
    {
      label: 'Starts',
      value: <Text size="sm">{formatDate(challenge.startsAt, 'MMM DD, YYYY hh:mm a')}</Text>,
    },
    {
      label: 'Ends',
      value: <Text size="sm">{formatDate(challenge.endsAt, 'MMM DD, YYYY hh:mm a')}</Text>,
    },
    {
      label: 'Max Entries',
      value: <Text size="sm">{challenge.maxEntriesPerUser} per user</Text>,
    },
    ...(currentUser && isActive
      ? [
          {
            label: 'Your Entries',
            value: (
              <Text size="sm" fw={500} c={userEntryCount > 0 ? 'green' : undefined}>
                {userEntryCount} / {challenge.maxEntriesPerUser}
              </Text>
            ),
          },
        ]
      : []),
    ...(challenge.entryPrize && challenge.entryPrizeRequirement > 0
      ? [
          {
            label: 'Participation Prize Requirement',
            value: <Text size="sm">Min {challenge.entryPrizeRequirement} entries to qualify</Text>,
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
      {/* Action buttons - hidden on mobile, replaced by sticky CTA */}
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
        <ShareButton url={router.asPath} title={challenge.title}>
          <Button
            className="shrink-0 grow-0"
            style={{ paddingLeft: 0, paddingRight: 0, width: '36px' }}
            color={colorScheme === 'dark' ? 'dark.6' : 'gray.1'}
          >
            <IconShare3 />
          </Button>
        </ShareButton>
      </Group>

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
            className={`w-full overflow-hidden ${isFirst ? 'aspect-square' : 'aspect-[4/3]'}`}
            style={{ cursor: 'pointer' }}
          >
            <EdgeMedia2
              src={winner.imageUrl}
              type={MediaType.image}
              width={450}
              className="size-full object-cover transition-transform duration-300 hover:scale-105"
            />
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

  const isActive = challenge.status === ChallengeStatus.Active;
  const hasCollection = !!challenge.collectionId;
  const displaySubmitAction = isActive && hasCollection && !currentUser?.muted;

  const handleOpenSubmitModal = () => {
    if (challenge.collectionId) {
      dialogStore.trigger({
        component: ChallengeSubmitModal,
        props: { challengeId: challenge.id, collectionId: challenge.collectionId },
      });
    }
  };

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
              {displaySubmitAction && (
                <Group gap="xs">
                  <Button
                    size="sm"
                    variant="filled"
                    onClick={() => openChallengeGenerator(challenge.modelVersionIds)}
                    leftSection={<IconBrush size={16} />}
                  >
                    Generate Entries
                  </Button>
                  <Button
                    size="sm"
                    variant="light"
                    onClick={handleOpenSubmitModal}
                    leftSection={<IconPhoto size={16} />}
                  >
                    Submit Entries
                  </Button>
                </Group>
              )}
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
                  period: 'AllTime',
                  sort: ImageSort.Random,
                }}
                disableStoreFilters
              />
            )}
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Container>
  );
}

function MobileCTAInline({ challenge }: { challenge: ChallengeDetail }) {
  const colorScheme = useComputedColorScheme('dark');
  const currentUser = useCurrentUser();
  const router = useRouter();
  const isActive = challenge.status === ChallengeStatus.Active;

  if (!isActive || currentUser?.muted) return null;

  return (
    <Group gap="xs" wrap="nowrap" hiddenFrom="md" mt="md">
      <Stack gap="xs" style={{ flex: 1 }}>
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
        )}
      </Stack>
      <ShareButton url={router.asPath} title={challenge.title}>
        <ActionIcon
          size="lg"
          variant="default"
          color={colorScheme === 'dark' ? 'dark.6' : 'gray.1'}
        >
          <IconShare3 size={18} />
        </ActionIcon>
      </ShareButton>
    </Group>
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
