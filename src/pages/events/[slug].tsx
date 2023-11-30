import {
  Alert,
  Anchor,
  Button,
  Card,
  Center,
  Container,
  Divider,
  Grid,
  Group,
  Image,
  Loader,
  NumberInput,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import { IconBolt, IconBulb, IconChevronRight, IconClipboard } from '@tabler/icons-react';
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
import { Fragment, forwardRef, useMemo, useRef, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { Countdown } from '~/components/Countdown/Countdown';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { HolidayFrame } from '~/components/Decorations/HolidayFrame';
import { Lightbulb } from '~/components/Decorations/Lightbulb';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { EventContributors } from '~/components/Events/EventContributors';
import { SectionCard } from '~/components/Events/SectionCard';
import { WelcomeCard } from '~/components/Events/WelcomeCard';
import { useMutateEvent, useQueryEvent } from '~/components/Events/events.utils';
import { HeroCard } from '~/components/HeroCard/HeroCard';
import { JdrfLogo } from '~/components/Logo/JdrfLogo';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { env } from '~/env/client.mjs';
import { hideMobile, showMobile } from '~/libs/sx-helpers';
import { constants } from '~/server/common/constants';
import { eventSchema } from '~/server/schema/event.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate, stripTime } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const result = eventSchema.safeParse({ event: ctx.query.slug });
    if (!result.success) return { notFound: true };

    const { event } = result.data;
    if (ssg) {
      await ssg.event.getTeamScores.prefetch({ event });
      await ssg.event.getTeamScoreHistory.prefetch({ event });
      await ssg.event.getCosmetic.prefetch({ event });
      await ssg.event.getData.prefetch({ event });
    }

    return { props: { event } };
  },
});

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ChartTooltip);
const options: ChartOptions<'line'> = {
  responsive: true,
  elements: {
    point: { pointStyle: 'cross' },
  },
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

const aboutText =
  "Your challenge is to post an image, model or article on a daily basis throughout December. For each day you complete a post, you'll receive a new lightbulb on your wreath in the team color randomly assigned to you when you join the challenge. The more bulbs you collect, the more badges you can win! The more buzz used to boost your team spirit bank, the brighter your lights shine. The brighter your lines shine, the bigger your bragging rights. The team with the brightest lights and highest spirit bank score wins a shiny new animated badge!";

export default function EventPageDetails({
  event,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const theme = useMantineTheme();

  const inputRef = useRef<HTMLInputElement>(null);

  const {
    eventData,
    teamScores,
    teamScoresHistory,
    eventCosmetic,
    rewards,
    userRank,
    loading,
    loadingHistory,
    loadingRewards,
    loadingUserRank,
  } = useQueryEvent({ event });

  const userTeam = (eventCosmetic?.cosmetic?.data as { type: string; color: string })?.color;
  const totalTeamScores = teamScores.reduce((acc, teamScore) => acc + teamScore.score, 0);
  const cosmeticData = eventCosmetic?.data as { lights: number; upgradedLights: number };

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
  if (!eventData) return <NotFound />;

  const handleFocusDonateInput = () => inputRef.current?.focus();

  const equipped = eventCosmetic?.obtained && eventCosmetic?.equipped;

  return (
    <>
      <Meta
        title={`${eventData.title} | Civitai`}
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/events/${event}`, rel: 'canonical' }]}
      />
      <Container size="md">
        <Stack spacing={48}>
          <Paper
            radius="md"
            sx={(theme) => ({
              backgroundImage: eventData?.coverImage
                ? `url(${getEdgeUrl(eventData.coverImage, { width: 1600 })})`
                : undefined,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'top',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              aspectRatio: '3',

              [theme.fn.smallerThan('sm')]: {
                aspectRatio: '1',
              },
            })}
          >
            <Stack
              spacing={0}
              py="sm"
              px="md"
              sx={(theme) => ({
                width: '100%',
                background: theme.fn.linearGradient(0, 'rgba(37,38,43,0.8)', 'rgba(37,38,43,0)'),
              })}
            >
              <Title color="white" sx={hideMobile}>
                {eventData?.title}
              </Title>
              <Group spacing="xs" position="apart">
                <Text color="white" size="sm" sx={hideMobile}>
                  {formatDate(eventData?.startDate, 'MMMM D, YYYY')} -{' '}
                  {formatDate(eventData?.endDate, 'MMMM D, YYYY')}
                </Text>
                {eventData?.coverImageUser && (
                  <Text color="white" size="xs">
                    Banner created by{' '}
                    <Link href={`/user/${eventData.coverImageUser}`} passHref>
                      <Anchor target="_blank" td="underline" span>
                        {eventData.coverImageUser}
                      </Anchor>
                    </Link>
                  </Text>
                )}
              </Group>
            </Stack>
          </Paper>
          <Stack sx={showMobile} spacing={0} mt="-xl">
            <Title color="white" sx={{ fontSize: '28px' }}>
              {eventData?.title}
            </Title>
            <Text color="white" size="sm">
              {formatDate(eventData?.startDate, 'MMMM D, YYYY')} -{' '}
              {formatDate(eventData?.endDate, 'MMMM D, YYYY')}
            </Text>
          </Stack>
          {!equipped && <WelcomeCard event={event} about={aboutText} />}
          <CharitySection visible={!equipped} />
          <Grid gutter={48}>
            {eventCosmetic?.cosmetic && equipped && (
              <>
                <Grid.Col xs={12} sm="auto">
                  <Card
                    py="xl"
                    px="lg"
                    radius="lg"
                    h="100%"
                    style={{ display: 'flex', alignItems: 'center' }}
                  >
                    <Stack align="center" w="100%">
                      <HolidayFrame cosmetic={eventCosmetic.cosmetic} data={cosmeticData} />
                      <Text size="xl" weight={590}>
                        {eventCosmetic.cosmetic.name}
                      </Text>
                      <Group spacing={4} align="center">
                        <Lightbulb color={userTeam} size={48} transform="rotate(180)" />
                        <Text size={80} weight={590} color={userTeam} inline>
                          {cosmeticData.lights ?? 0}
                        </Text>{' '}
                        <Text size={32} weight={590} color="dimmed" inline>
                          / 31
                        </Text>
                      </Group>
                      {eventCosmetic.available && (
                        <>
                          <Link href="/posts/create">
                            <Button color="gray" variant="filled" radius="xl" fullWidth>
                              <Group spacing={4} noWrap>
                                <IconBulb size={18} />
                                Earn more lights
                              </Group>
                            </Button>
                          </Link>
                          <Button
                            color="gray"
                            variant="filled"
                            radius="xl"
                            onClick={handleFocusDonateInput}
                            fullWidth
                          >
                            <Group spacing={4} noWrap>
                              <IconBolt size={18} />
                              Make it brighter
                            </Group>
                          </Button>
                        </>
                      )}
                    </Stack>
                  </Card>
                </Grid.Col>
                {/* <Grid.Col xs={12} sm="auto">
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
                          const brightness =
                            (teamScores.length - teamScore.rank + 1) / teamScores.length;

                          return (
                            <Fragment key={teamScore.team}>
                              <Group spacing={8} position="apart">
                                <Group spacing={4} noWrap>
                                  <Text size="xl" weight={590} color={color}>
                                    {teamScore.rank}
                                  </Text>
                                  <Lightbulb
                                    variant="star"
                                    color={'yellow'}
                                    brightness={brightness}
                                    size={32}
                                  />
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
                </Grid.Col> */}
                <Grid.Col xs={12} sm="auto">
                  <Card
                    py="xl"
                    px="lg"
                    radius="lg"
                    h="100%"
                    style={{ display: 'flex', alignItems: 'center' }}
                  >
                    <Stack align="center" w="100%" spacing="lg">
                      <Lightbulb variant="star" color={userTeam} size={80} />
                      <Stack spacing={4} align="center">
                        <Text size={24} weight={600} align="center" inline>
                          Your rank in {userTeam} team
                        </Text>
                        {loadingUserRank ? (
                          <Loader variant="bars" />
                        ) : (
                          <Text size={96} weight="bold" align="center" color={userTeam} inline>
                            {userRank?.toLocaleString()}
                          </Text>
                        )}
                      </Stack>
                      <Link href={`/leaderboard/${event}:${userTeam}`}>
                        <Button color="gray" radius="xl" fullWidth>
                          <Group spacing={4} noWrap>
                            <IconClipboard size={18} />
                            Team leaderboard
                          </Group>
                        </Button>
                      </Link>
                    </Stack>
                  </Card>
                </Grid.Col>
              </>
            )}
            <Grid.Col span={12}>
              <SectionCard
                title="Team spirit donation history"
                subtitle="See how your team is doing. The team with the most donations at the end of the event will get a special prize"
              >
                {equipped && <DonateInput event={event} ref={inputRef} />}
                {loadingHistory ? (
                  <Center py="xl">
                    <Loader variant="bars" />
                  </Center>
                ) : (
                  <Stack spacing={40} w="100%" align="center">
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
                    <Group spacing="md">
                      {teamScores.length > 0 &&
                        teamScores.map((teamScore) => (
                          <Group key={teamScore.team} spacing={4} noWrap>
                            <ThemeIcon color={teamScore.team.toLowerCase()} radius="xl" size={12}>
                              {null}
                            </ThemeIcon>
                            <Text
                              size="xs"
                              color="dimmed"
                              transform="uppercase"
                              weight={500}
                              lineClamp={1}
                            >
                              {abbreviateNumber(teamScore.score, { decimals: 2 })}
                            </Text>
                          </Group>
                        ))}
                    </Group>
                  </Stack>
                )}
              </SectionCard>
            </Grid.Col>
            <Grid.Col span={12}>
              <SectionCard
                title="Event rewards"
                subtitle="For each milestone you reach, you will get a reward. Stay active while the event is ongoing to get all the rewards."
              >
                {loadingRewards ? (
                  <Center py="xl">
                    <Loader variant="bars" />
                  </Center>
                ) : rewards.length === 0 ? (
                  <Alert color="red" radius="xl" ta="center" w="100%" py={8}>
                    No rewards available
                  </Alert>
                ) : (
                  <SimpleGrid
                    spacing={40}
                    breakpoints={[
                      { minWidth: 'xs', cols: 1 },
                      { minWidth: 'sm', cols: 3 },
                      { minWidth: 'md', cols: 5 },
                    ]}
                  >
                    {rewards.map((reward) => (
                      <Stack key={reward.id} spacing={8} align="center">
                        <div style={{ width: 96 }}>
                          <EdgeMedia src={(reward.data as { url: string })?.url} width={256} />
                        </div>
                        <Text align="center" size="lg" weight={590} w="100%">
                          {reward.name}
                        </Text>
                      </Stack>
                    ))}
                  </SimpleGrid>
                )}
              </SectionCard>
            </Grid.Col>
          </Grid>
          <EventContributors event={event} />
          {equipped && (
            <>
              <Divider w="80px" mx="auto" />
              <Stack spacing={20}>
                <Title
                  order={2}
                  align="center"
                  sx={(theme) => ({
                    fontSize: '64px',
                    [theme.fn.smallerThan('sm')]: {
                      fontSize: '28px',
                    },
                  })}
                >
                  About the challenge
                </Title>
                <Text
                  color="dimmed"
                  sx={(theme) => ({
                    fontSize: '24px',
                    [theme.fn.smallerThan('sm')]: {
                      fontSize: '18px',
                    },
                  })}
                >
                  {aboutText}
                </Text>
              </Stack>
              <CharitySection visible />
            </>
          )}
        </Stack>
      </Container>
    </>
  );
}

const DonateInput = forwardRef<HTMLInputElement, { event: string }>(({ event }, ref) => {
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
        ref={ref}
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
    </Group>
  );
});
DonateInput.displayName = 'DonateInput';

const partners = [
  {
    title: 'RunDiffusion',
    subtitle: 'Matching 500k Buzz to charity',
    // TODO.justin: get the right image for runDiffusion
    image:
      'https://assets-global.website-files.com/634b388c3e23ccc5dec6843f/63bf61d57842c5d0a39255fb_Final-10-Small-2.png',
  },
];

const CharitySection = ({ visible }: { visible: boolean }) => {
  if (!visible) return null;

  return (
    <>
      <HeroCard
        title={<JdrfLogo width={145} height={40} />}
        description="Civitai is matching all purchased buzz spent across team spirit banks to donate to the global charity, the Juvenile Diabetes Research Foundation."
        // TODO.justin: get the right image for jdrf
        imageUrl="https://www.jdrf.org/wp-content/uploads/2023/02/d-b-1-800x474-1.png"
        externalLink="https://www.jdrf.org/"
      />
      <SectionCard
        title="Matching Partners"
        subtitle="Each of our partners will match the buzz amount we donate at the end of the month, to the JDRF."
        headerAlign="left"
      >
        {/* TODO.justin: handle on click */}
        <Button
          size="md"
          color="gray"
          radius="xl"
          sx={{ alignSelf: 'flex-start' }}
          rightIcon={<IconChevronRight />}
        >
          Become a partner
        </Button>
        <SimpleGrid
          breakpoints={[
            { minWidth: 'xs', cols: 1 },
            { minWidth: 'sm', cols: 2 },
          ]}
        >
          {partners.map((partner, index) => (
            <Group key={index} spacing="sm">
              <Image
                src={partner.image}
                alt={partner.title}
                width={120}
                height={120}
                radius={60}
                sx={(theme) => ({ backgroundColor: theme.colors.dark[7], borderRadius: 60 })}
                imageProps={{
                  style: { objectFit: 'cover', objectPosition: 'left', width: 120, height: 120 },
                }}
              />
              <Stack spacing={4}>
                <Text size={20} weight={600}>
                  {partner.title}
                </Text>
                <Text size={16} color="dimmed">
                  {partner.subtitle}
                </Text>
              </Stack>
            </Group>
          ))}
        </SimpleGrid>
      </SectionCard>
    </>
  );
};
