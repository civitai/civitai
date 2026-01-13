import type { BadgeProps } from '@mantine/core';
import {
  Accordion,
  Badge,
  Button,
  Center,
  Container,
  Divider,
  Group,
  Loader,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  useMantineTheme,
  useComputedColorScheme,
} from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next';
import React, { useMemo } from 'react';
import * as z from 'zod';

import { Page } from '~/components/AppLayout/Page';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency, ChallengeStatus } from '~/shared/utils/prisma/enums';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import {
  IconCalendar,
  IconClockHour4,
  IconPhoto,
  IconShare3,
  IconSparkles,
  IconTrophy,
  IconUsers,
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
// import { TrackView } from '~/components/TrackView/TrackView'; // TODO: Add Challenge entity type
import { env } from '~/env/client';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { MediaType } from '~/shared/utils/prisma/enums';
import { NoContent } from '~/components/NoContent/NoContent';
import type { ChallengeDetail } from '~/server/routers/challenge.router';

const querySchema = z.object({
  id: z.coerce.number(),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };

    if (ssg) {
      await ssg.challenge.getById.prefetch({ id: result.data.id });
    }

    return { props: removeEmpty(result.data) };
  },
});

function ChallengeDetailsPage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const mobile = useContainerSmallerThan('sm');
  const { data: challenge, isLoading } = useQueryChallenge(id);

  if (isLoading) return <PageLoader />;
  if (!challenge) return <NotFound />;

  const now = new Date();
  const isActive = challenge.status === ChallengeStatus.Active;
  const isCompleted = challenge.status === ChallengeStatus.Completed;
  const isScheduled = challenge.status === ChallengeStatus.Scheduled;

  return (
    <>
      <Meta
        title={`${challenge.title} | Civitai Challenges`}
        description={challenge.description || `Participate in the ${challenge.title} challenge on Civitai`}
        links={[
          {
            href: `${env.NEXT_PUBLIC_BASE_URL as string}/challenges/${challenge.id}/${slugit(challenge.title)}`,
            rel: 'canonical',
          },
        ]}
      />
      <SensitiveShield contentNsfwLevel={challenge.nsfwLevel}>
        {/* TODO: Add Challenge to TrackView entity types */}
        <Container size="xl" mb={32}>
          <Stack gap="xs" mb="xl">
            {/* Header Section */}
            <Group justify="space-between" wrap="nowrap">
              <Group gap="xs" wrap="wrap">
                <Title fw="bold" lineClamp={2} order={1}>
                  {challenge.title}
                </Title>
                <Group gap={8}>
                  <CurrencyBadge
                    size="lg"
                    radius="sm"
                    currency={Currency.BUZZ}
                    unitAmount={challenge.prizePool}
                    variant="light"
                  />
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
                    <IconBadge
                      size="lg"
                      radius="sm"
                      color="green"
                      icon={<IconSparkles size={16} />}
                    >
                      Live
                    </IconBadge>
                  ) : isScheduled ? (
                    <Badge size="lg" radius="sm" color="blue">
                      Upcoming
                    </Badge>
                  ) : null}
                  {isActive && (
                    <IconBadge
                      size="lg"
                      radius="sm"
                      icon={<IconClockHour4 size={18} />}
                      color="gray"
                    >
                      <DaysFromNow date={challenge.endsAt} withoutSuffix />
                    </IconBadge>
                  )}
                  <IconBadge
                    size="lg"
                    radius="sm"
                    icon={<IconPhoto size={18} />}
                    color="gray"
                  >
                    {abbreviateNumber(challenge.entryCount)} entries
                  </IconBadge>
                </Group>
              </Group>
            </Group>

            {/* Subheader with theme and dates */}
            <Group gap={8}>
              {challenge.theme && (
                <>
                  <Text c="dimmed" size="sm">
                    Theme: <Text component="span" fw={600}>{challenge.theme}</Text>
                  </Text>
                  <Divider orientation="vertical" />
                </>
              )}
              <Text c="dimmed" size="sm">
                {formatDate(challenge.startsAt, undefined, true)} - {formatDate(challenge.endsAt, undefined, true)}
              </Text>
            </Group>
          </Stack>

          <ContainerGrid2 gutter={{ md: 32, lg: 64 }}>
            <ContainerGrid2.Col span={{ base: 12, md: 4 }} order={{ md: 2 }}>
              <ChallengeSidebar challenge={challenge} />
            </ContainerGrid2.Col>
            <ContainerGrid2.Col span={{ base: 12, md: 8 }} order={{ md: 1 }}>
              <Stack gap="md">
                {/* Cover Image */}
                {challenge.coverUrl && (
                  <div className="overflow-hidden rounded-lg">
                    <EdgeMedia2
                      src={challenge.coverUrl}
                      type={MediaType.image}
                      width={800}
                      className="w-full"
                    />
                  </div>
                )}

                {/* Invitation/Description */}
                {challenge.invitation && (
                  <div className="rounded-lg bg-blue-500/10 p-4">
                    <Text size="lg" fw={500} className="italic">
                      &ldquo;{challenge.invitation}&rdquo;
                    </Text>
                  </div>
                )}

                {/* About */}
                <Title order={2} mt="sm">
                  About this challenge
                </Title>
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
              </Stack>
            </ContainerGrid2.Col>
          </ContainerGrid2>
        </Container>

        {/* Winners Section (for completed challenges) */}
        {isCompleted && challenge.winners.length > 0 && (
          <ChallengeWinners challenge={challenge} />
        )}

        {/* Entries Section */}
        <ChallengeEntries challenge={challenge} />
      </SensitiveShield>
    </>
  );
}

function ChallengeSidebar({ challenge }: { challenge: ChallengeDetail }) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const router = useRouter();
  const currentUser = useCurrentUser();

  const isActive = challenge.status === ChallengeStatus.Active;
  const isCompleted = challenge.status === ChallengeStatus.Completed;

  const challengeDetails: DescriptionTableProps['items'] = [
    {
      label: 'Starts',
      value: <Text size="sm">{formatDate(challenge.startsAt, undefined, true)}</Text>,
    },
    {
      label: 'Ends',
      value: <Text size="sm">{formatDate(challenge.endsAt, undefined, true)}</Text>,
    },
    {
      label: 'Max Entries',
      value: <Text size="sm">{challenge.maxEntriesPerUser} per user</Text>,
    },
    {
      label: 'Featured Model',
      value: challenge.model ? (
        <Link href={`/models/${challenge.model.id}`}>
          <Text size="sm" c="blue">{challenge.model.name}</Text>
        </Link>
      ) : (
        <Text size="sm" c="dimmed">Any model</Text>
      ),
    },
  ];

  // Prize breakdown
  const prizeItems: DescriptionTableProps['items'] = challenge.prizes.map((prize, index) => ({
    label: (
      <Group gap={4}>
        <ThemeIcon size="sm" color={index === 0 ? 'yellow' : index === 1 ? 'gray.4' : 'orange.7'} variant="light">
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

  if (challenge.entryPrize) {
    prizeItems.push({
      label: <Text size="sm">Participation</Text>,
      value: (
        <CurrencyBadge
          size="sm"
          currency={Currency.BUZZ}
          unitAmount={challenge.entryPrize.buzz}
          variant="transparent"
        />
      ),
    });
  }

  return (
    <Stack gap="md">
      {/* Action buttons */}
      <Group gap={8} wrap="nowrap">
        {isActive && !currentUser?.muted && (
          <Button
            component={Link}
            href={`/generate?challengeId=${challenge.id}`}
            leftSection={<IconSparkles size={16} />}
            variant="filled"
            color="blue"
            fullWidth
          >
            Enter Challenge
          </Button>
        )}
        <ShareButton url={router.asPath} title={challenge.title}>
          <Button
            style={{ paddingLeft: 0, paddingRight: 0, width: '36px' }}
            color={colorScheme === 'dark' ? 'dark.6' : 'gray.1'}
          >
            <IconShare3 />
          </Button>
        </ShareButton>
      </Group>

      {/* Moderator link */}
      {currentUser?.isModerator && (
        <Button
          component={Link}
          href={`/moderator/challenges?id=${challenge.id}`}
          variant="light"
          size="xs"
        >
          Manage Challenge
        </Button>
      )}

      <Accordion
        variant="separated"
        multiple
        defaultValue={['details', 'prizes']}
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
            <DescriptionTable
              items={challengeDetails}
              labelWidth="35%"
              withBorder
              paperProps={{
                style: {
                  borderLeft: 0,
                  borderRight: 0,
                  borderBottom: 0,
                },
                radius: 0,
              }}
            />
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="prizes">
          <Accordion.Control>
            <Group justify="space-between">Prizes</Group>
          </Accordion.Control>
          <Accordion.Panel>
            <ScrollArea.Autosize mah={300}>
              <DescriptionTable
                items={prizeItems}
                labelWidth="50%"
                withBorder
                paperProps={{
                  style: {
                    borderLeft: 0,
                    borderRight: 0,
                    borderBottom: 0,
                  },
                  radius: 0,
                }}
              />
            </ScrollArea.Autosize>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="creator">
          <Accordion.Control>
            <Group justify="space-between">Created By</Group>
          </Accordion.Control>
          <Accordion.Panel>
            <div className="p-3">
              <UserAvatar
                user={challenge.createdBy}
                withUsername
                linkToProfile
              />
            </div>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}

function ChallengeWinners({ challenge }: { challenge: ChallengeDetail }) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  return (
    <Container
      fluid
      my="md"
      style={{
        background: colorScheme === 'dark' ? theme.colors.yellow[9] + '20' : theme.colors.yellow[1],
      }}
    >
      <Container size="xl">
        <Stack gap="md" py={32}>
          <Group gap="xs">
            <ThemeIcon size="lg" color="yellow" variant="light">
              <IconTrophy size={20} />
            </ThemeIcon>
            <Title order={2}>Winners</Title>
          </Group>
          <SimpleGrid
            cols={{
              base: 1,
              sm: 2,
              md: Math.min(challenge.winners.length, 3),
            }}
            spacing="md"
          >
            {challenge.winners.map((winner) => (
              <div
                key={winner.place}
                className="flex flex-col gap-2 rounded-lg bg-black/10 p-4 dark:bg-white/5"
              >
                <Group justify="space-between">
                  <Badge
                    size="lg"
                    color={winner.place === 1 ? 'yellow' : winner.place === 2 ? 'gray.4' : 'orange.7'}
                    leftSection={<IconTrophy size={14} />}
                  >
                    {getPlaceLabel(winner.place)}
                  </Badge>
                  <CurrencyBadge
                    currency={Currency.BUZZ}
                    unitAmount={winner.buzzAwarded}
                    size="lg"
                  />
                </Group>
                {winner.imageUrl && (
                  <div className="aspect-square overflow-hidden rounded-md">
                    <EdgeMedia2
                      src={winner.imageUrl}
                      type={MediaType.image}
                      width={400}
                      className="h-full w-full object-cover"
                    />
                  </div>
                )}
                <Link href={`/user/${winner.username}`}>
                  <Text size="sm" fw={600}>{winner.username}</Text>
                </Link>
                {winner.reason && (
                  <Text size="xs" c="dimmed" lineClamp={2}>{winner.reason}</Text>
                )}
              </div>
            ))}
          </SimpleGrid>
        </Stack>
      </Container>
    </Container>
  );
}

function ChallengeEntries({ challenge }: { challenge: ChallengeDetail }) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const currentUser = useCurrentUser();

  const isActive = challenge.status === ChallengeStatus.Active;
  const displaySubmitAction = isActive && !currentUser?.muted;

  // Entries are stored in the challenge's collection
  const collectionUrl = `/collections/${challenge.collectionId}`;

  return (
    <Container
      fluid
      my="md"
      style={{
        background: colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1],
      }}
    >
      <Container size="xl">
        <Stack gap="md" py={32}>
          <Group>
            <Title order={2}>Entries</Title>
            {displaySubmitAction && (
              <Button
                size="xs"
                variant="outline"
                component={Link}
                href={`/posts/create?collectionId=${challenge.collectionId}`}
                leftSection={<IconSparkles size={14} />}
              >
                Submit Entry
              </Button>
            )}
            <Text c="dimmed" size="sm">
              {challenge.entryCount.toLocaleString()} total entries
            </Text>
          </Group>

          {challenge.entryCount === 0 ? (
            <NoContent
              message={
                isActive
                  ? 'No entries yet. Be the first to submit!'
                  : 'No entries for this challenge.'
              }
            />
          ) : (
            <Stack gap="md">
              <Text c="dimmed">
                View all entries in the challenge collection.
              </Text>
              <Button
                component={Link}
                href={collectionUrl}
                variant="light"
                leftSection={<IconPhoto size={16} />}
              >
                View {challenge.entryCount.toLocaleString()} Entries
              </Button>
            </Stack>
          )}
        </Stack>
      </Container>
    </Container>
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
