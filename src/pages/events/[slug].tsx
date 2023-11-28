import {
  Alert,
  Button,
  Card,
  Center,
  Container,
  Grid,
  Group,
  Loader,
  NumberInput,
  Paper,
  Stack,
  Text,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import { IconBulb } from '@tabler/icons-react';
import {
  CategoryScale,
  Chart as ChartJS,
  ChartOptions,
  Tooltip as ChartTooltip,
  LineElement,
  LinearScale,
  PointElement,
} from 'chart.js';
import dayjs from 'dayjs';
import { InferGetServerSidePropsType } from 'next';
import Link from 'next/link';
import { Fragment, useMemo, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { Countdown } from '~/components/Countdown/Countdown';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { HolidayFrame } from '~/components/Decorations/HolidayFrame';
import { Lightbulb } from '~/components/Decorations/Lightbulb';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useMutateEvent, useQueryEvent } from '~/components/Events/events.utils';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { env } from '~/env/client.mjs';
import { constants } from '~/server/common/constants';
import { eventSchema } from '~/server/schema/event.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate, stripTime } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { NextLink } from '@mantine/next';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const result = eventSchema.safeParse({ event: ctx.query.slug });
    if (!result.success) return { notFound: true };

    const { event } = result.data;
    if (ssg) {
      await ssg.event.getTeamScores.prefetch({ event });
      await ssg.event.getCosmetic.prefetch({ event });
    }

    return { props: { event } };
  },
});

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ChartTooltip);
const options: ChartOptions<'line'> = {
  aspectRatio: 2.5,
  scales: {
    x: { grid: { display: false } },
    y: { grid: { display: false } },
  },
  plugins: {
    legend: { display: false },
    title: { display: false },
  },
};

const resetTime = dayjs().utc().endOf('day').toDate();
const startTime = dayjs().utc().startOf('day').toDate();

export default function EventPageDetails({
  event,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const theme = useMantineTheme();

  const {
    eventData,
    teamScores,
    teamScoresHistory,
    eventCosmetic,
    rewards,
    loading,
    loadingHistory,
    loadingRewards,
  } = useQueryEvent({ event });
  const { activateCosmetic, equipping } = useMutateEvent();

  const userTeam = (eventCosmetic?.cosmetic?.data as { type: string; color: string })?.color;
  const teamColorTheme = theme.colors[userTeam.toLowerCase()];
  const totalTeamScores = teamScores.reduce((acc, teamScore) => acc + teamScore.score, 0);
  const cosmeticData = eventCosmetic?.data as { lights: number; lightUpgrades: number };

  const labels = useMemo(
    () =>
      Array.from(
        new Set(
          teamScoresHistory
            .flatMap((teamScore) => teamScore.scores.map((score) => score.date))
            .sort((a, b) => a.getTime() - b.getTime())
            .map((date) => formatDate(stripTime(date), 'MMM-DD'))
        )
      ),
    [teamScoresHistory]
  );

  const updatedTeamScoresHistory = useMemo(
    () =>
      teamScoresHistory.map((teamScore) => {
        let lastMatchedIndex = -1;

        return {
          ...teamScore,
          scores: labels.map((label, index) => {
            const matchedScore = teamScore.scores.find(
              (score) => formatDate(stripTime(score.date), 'MMM-DD') === label
            );

            if (matchedScore) {
              lastMatchedIndex = index;
              return { date: label, score: matchedScore?.score };
            } else {
              return { date: label, score: teamScore.scores[lastMatchedIndex]?.score ?? 0 };
            }
          }),
        };
      }),
    [labels, teamScoresHistory]
  );

  if (loading) return <PageLoader />;
  if (!eventCosmetic) return <NotFound />;

  const handleEquipCosmetic = async () => {
    try {
      await activateCosmetic({ event });
    } catch (e) {
      const error = e as Error;
      showErrorNotification({ title: 'Unable to equip cosmetic', error });
    }
  };

  return (
    <>
      <Meta
        title={`${eventCosmetic.cosmetic?.name} | Civitai`}
        description={eventCosmetic.cosmetic?.description ?? undefined}
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/events/${event}`, rel: 'canonical' }]}
      />
      <Container size="md">
        <Stack spacing={40}>
          <Paper
            h="300px"
            radius="md"
            style={{
              backgroundImage: eventData?.coverImage
                ? `url(${getEdgeUrl(eventData.coverImage, { width: 1600 })})`
                : undefined,
              backgroundPosition: 'top',
            }}
          >
            <Center w="100%" h="100%" style={{ backgroundColor: 'rgba(0, 0, 0, 0.3)' }}>
              <Stack spacing={0}>
                <Title color="white" align="center">
                  {eventData?.title}
                </Title>
                {eventData?.coverImageUser && (
                  <Text color="white" size="xs" align="center">
                    Banner created by{' '}
                    <Text
                      component={NextLink}
                      target="_blank"
                      href={`/user/${eventData.coverImageUser}`}
                      td="underline"
                    >
                      {eventData.coverImageUser}
                    </Text>
                  </Text>
                )}
              </Stack>
            </Center>
          </Paper>
          <Text>
            <b>This was made with GitHub Copilot :^)</b> The holidays are a time for giving, and we
            want to give back to the community that has given us so much. For the next 12 days,
            we&apos;ll be donating to a different charity each day. We&apos;ll also be giving away a
            new cosmetic each day, and you can get involved by donating to the charity of the day.
          </Text>
          <Title order={2}>Event Overview</Title>
          <Grid gutter={48}>
            <Grid.Col xs={12} sm="auto">
              <Card
                py="xl"
                px="lg"
                radius="lg"
                h="100%"
                style={{ display: 'flex', alignItems: 'center' }}
              >
                {eventCosmetic.cosmetic && (
                  <Stack align="center">
                    <HolidayFrame cosmetic={eventCosmetic.cosmetic} />
                    <Text size="xl" weight={590}>
                      {eventCosmetic.cosmetic.name}
                    </Text>
                    <Group spacing="xs">
                      <Lightbulb color={userTeam} size={32} transform="rotate(180)" />
                      <Text
                        size={32}
                        weight={590}
                        display="flex"
                        sx={{ alignItems: 'center', fontVariantNumeric: 'tabular-nums' }}
                        inline
                      >
                        <Text size={48} color={teamColorTheme[9]} mr={2} inline span>
                          {cosmeticData.lights ?? 0}
                        </Text>{' '}
                        / 31
                      </Text>
                    </Group>
                    {eventCosmetic.available && !eventCosmetic.equipped ? (
                      <Button
                        color="blue"
                        variant="light"
                        radius="xl"
                        onClick={handleEquipCosmetic}
                        loading={equipping}
                        fullWidth
                      >
                        Equip cosmetic
                      </Button>
                    ) : eventCosmetic.equipped ? null : (
                      <Alert color="red" radius="xl" ta="center" w="100%" py={8}>
                        This cosmetic is not available
                      </Alert>
                    )}
                    <Link href="/posts/create">
                      <Button color="gray" variant="filled" radius="xl" fullWidth>
                        <Group spacing={4} noWrap>
                          <IconBulb size={18} />
                          Earn more lights
                        </Group>
                      </Button>
                    </Link>
                  </Stack>
                )}
              </Card>
            </Grid.Col>
            <Grid.Col xs={12} sm="auto">
              <Card
                py="xl"
                px="lg"
                radius="lg"
                h="100%"
                style={{ display: 'flex', alignItems: 'center' }}
              >
                <Stack w="100%">
                  <Stack spacing={0} align="center">
                    <Text size="sm" weight={590}>
                      Total team donations
                    </Text>
                    <Group spacing={4} noWrap>
                      <CurrencyIcon currency={Currency.BUZZ} />
                      <Text size={32} weight={590} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                        {numberWithCommas(totalTeamScores)}
                      </Text>
                    </Group>
                  </Stack>
                  <Stack spacing={8} sx={{ ['&>*']: { flexGrow: 1 } }}>
                    <Group spacing={8} position="apart">
                      <Text size="sm" weight={590}>
                        Team Rank
                      </Text>
                      <Text size="sm" weight={590}>
                        Team Donations
                      </Text>
                    </Group>
                    {teamScores.map((teamScore) => {
                      const color = teamScore.team.toLowerCase();

                      return (
                        <Fragment key={teamScore.team}>
                          <Group spacing={8} position="apart">
                            <Group spacing={4} noWrap>
                              <Text size="xl" weight={590} color={color}>
                                {teamScore.rank}
                              </Text>
                              <Lightbulb variant="star" color={color} size={32} />
                            </Group>
                            <Group spacing={4} noWrap>
                              <CurrencyIcon currency={Currency.BUZZ} />
                              <Text
                                size="xl"
                                weight={590}
                                sx={{ fontVariantNumeric: 'tabular-nums' }}
                              >
                                {numberWithCommas(teamScore.score)}
                              </Text>
                            </Group>
                          </Group>
                        </Fragment>
                      );
                    })}
                  </Stack>
                  <Text size="xs" color="dimmed">
                    As of {formatDate(startTime, 'MMMM D, YYYY h:mma')}. Refreshes in:{' '}
                    <Countdown endTime={resetTime} />
                  </Text>
                </Stack>
              </Card>
            </Grid.Col>
            <Grid.Col span={12}>
              <Card py="xl" px="lg" radius="lg">
                <Stack spacing="xl" align="center">
                  <Stack spacing={0} align="center">
                    <Title order={2}>Team spirit donation history</Title>
                    <Text color="dimmed">
                      See how your team is doing. The team with the most donations at the end of the
                      event will get a special prize
                    </Text>
                  </Stack>
                  <DonateInput event={event} />
                  {loadingHistory ? (
                    <Center py="xl">
                      <Loader variant="bars" />
                    </Center>
                  ) : (
                    <Line
                      options={options}
                      data={{
                        labels,
                        datasets: updatedTeamScoresHistory.map(({ team, scores }) => {
                          const color = theme.colors[team.toLowerCase()][theme.fn.primaryShade()];
                          return {
                            label: 'Buzz donated',
                            data: scores.map(({ score }) => score),
                            borderColor: color,
                            backgroundColor: color,
                          };
                        }),
                      }}
                    />
                  )}
                </Stack>
              </Card>
            </Grid.Col>
          </Grid>
          <Card py="xl" px="lg" radius="lg">
            <Stack align="center" spacing="xl">
              <Stack spacing={0} align="center">
                <Title order={2}>Event rewards</Title>
                <Text color="dimmed">
                  For each milestone you reach, you will get a reward. Stay active while the event
                  is ongoing to get all the rewards.
                </Text>
              </Stack>
              <Group spacing={40} w="100%" position="center">
                {loadingRewards ? (
                  <Center py="xl">
                    <Loader variant="bars" />
                  </Center>
                ) : rewards.length === 0 ? (
                  <Alert color="red" radius="xl" ta="center" w="100%" py={8}>
                    No rewards available
                  </Alert>
                ) : (
                  rewards.map((reward) => (
                    <Stack key={reward.id} spacing={8} align="center" w="calc(20% - 40px)">
                      <div style={{ width: 96 }}>
                        <EdgeMedia src={(reward.data as { url: string })?.url} width={256} />
                      </div>
                      <Text align="center" size="lg" weight={590} w="100%">
                        {reward.name}
                      </Text>
                    </Stack>
                  ))
                )}
              </Group>
            </Stack>
          </Card>
          <Stack align="center">
            <Stack spacing={0}>
              <Title align="center" order={2}>
                What happens at the end of the event?
              </Title>
              <Text color="dimmed" align="center">
                At the end of the event, we will be donating all the Buzz raised in money to a good
                cause.
              </Text>
            </Stack>
            <Group w="100%" grow>
              {Array.from({ length: 3 }).map((_, index) => (
                <Card
                  key={index}
                  radius="lg"
                  h={100}
                  style={{ display: 'flex', alignItems: 'center' }}
                >
                  <Text align="center" size="lg" weight={590} w="100%">
                    Charity {index + 1}
                  </Text>
                </Card>
              ))}
            </Group>
          </Stack>
        </Stack>
      </Container>
      {/* <DonationModal event={event} opened={opened} onClose={() => setOpened(false)} /> */}
    </>
  );
}

function DonateInput({ event }: { event: string }) {
  const [amount, setAmount] = useState<number>();

  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance: number) =>
      `You don't have enough funds to perform this action. Required buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more buzz to perform this action.`,
    purchaseSuccessMessage: (purchasedBalance) => (
      <Stack>
        <Text>Thank you for your purchase!</Text>
        <Text>
          We have added <CurrencyBadge currency={Currency.BUZZ} unitAmount={purchasedBalance} /> to
          your account and your donation has been sent.
        </Text>
      </Stack>
    ),
    performTransactionOnPurchase: true,
  });

  const { donate, donating } = useMutateEvent();

  const handleSubmit = () => {
    if (!amount || amount <= 0 || amount > constants.buzz.maxTipAmount) return;

    const performTransaction = async () => {
      try {
        await donate({ event, amount });
        setAmount(undefined);
      } catch (e) {
        const error = e as Error;
        showErrorNotification({ title: 'Unable to donate', error });
      }
    };

    conditionalPerformTransaction(amount, performTransaction);
  };

  return (
    <Group spacing={8} noWrap>
      <NumberInput
        placeholder="Your donation"
        icon={<CurrencyIcon currency={Currency.BUZZ} size={16} />}
        formatter={numberWithCommas}
        parser={(value?: string) => value && value.replace(/\$\s?|(,*)/g, '')}
        value={amount}
        onChange={setAmount}
        min={1}
        max={constants.buzz.maxTipAmount}
        rightSection={<Text size="xs">Buzz</Text>}
        rightSectionWidth="25%"
        hideControls
      />
      <Button color="yellow.7" loading={donating} onClick={handleSubmit}>
        Boost team
      </Button>
      {/* <BuzzTransactionButton
        label="Boost team"
        buzzAmount={amount ?? 0}
        color="yellow.7"
        loading={donating}
        onPerformTransaction={handleSubmit}
      /> */}
    </Group>
  );
}
