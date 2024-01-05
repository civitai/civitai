import {
  Button,
  Card,
  Center,
  Container,
  createStyles,
  Divider,
  Grid,
  Group,
  Loader,
  NumberInput,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { Currency } from '@prisma/client';
import { IconBolt, IconBulb, IconChevronRight } from '@tabler/icons-react';
import {
  CategoryScale,
  Chart as ChartJS,
  ChartOptions,
  Tooltip as ChartTooltip,
  LinearScale,
  LineElement,
  PointElement,
  TimeScale,
} from 'chart.js';
import 'chartjs-adapter-dayjs-4/dist/chartjs-adapter-dayjs-4.esm';
import dayjs from 'dayjs';
import { InferGetServerSidePropsType } from 'next';
import { forwardRef, Fragment, useMemo, useRef, useState } from 'react';
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
import { EventRewards } from '~/components/Events/EventRewards';
import { EventPartners, useMutateEvent, useQueryEvent } from '~/components/Events/events.utils';
import { SectionCard } from '~/components/Events/SectionCard';
import { WelcomeCard } from '~/components/Events/WelcomeCard';
import { HeroCard } from '~/components/HeroCard/HeroCard';
import { JdrfLogo } from '~/components/Logo/JdrfLogo';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { env } from '~/env/client.mjs';
import { constants } from '~/server/common/constants';
import { eventSchema } from '~/server/schema/event.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
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

ChartJS.register(CategoryScale, TimeScale, LinearScale, PointElement, LineElement, ChartTooltip);
const options: ChartOptions<'line'> = {
  responsive: true,
  elements: {
    point: { pointStyle: 'cross' },
  },
  scales: {
    x: { type: 'time', grid: { display: false } },
    y: { grid: { display: false } },
  },
  plugins: {
    legend: { display: false },
    title: { display: false },
  },
};

const resetTime = dayjs().utc().endOf('day').toDate();

const aboutText =
  "Your challenge is to post an image, model or article on a daily basis throughout December. For each day you complete a post, you'll receive a new lightbulb on your garland in the team color randomly assigned to you when you join the challenge. The more bulbs you collect, the more badges you can win! The more Buzz donated to your team bank, the brighter your lights shine. The brighter your lights shine, the bigger your bragging rights. The team with the brightest lights and highest Spirit Bank score wins a shiny new animated badge!";

export default function EventPageDetails({
  event,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { theme, classes } = useStyles();

  const inputRef = useRef<HTMLInputElement>(null);

  const {
    eventData,
    teamScores,
    teamScoresHistory,
    eventCosmetic,
    partners,
    loading,
    loadingHistory,
  } = useQueryEvent({ event });

  const userTeam = (eventCosmetic?.cosmetic?.data as { type: string; color: string })?.color;
  const totalTeamScores = teamScores.reduce((acc, teamScore) => acc + teamScore.score, 0);
  const cosmeticData = eventCosmetic?.data as { lights: number; upgradedLights: number };

  const datasets = useMemo(() => {
    const allDates = teamScoresHistory
      .flatMap((teamScore) => teamScore.scores.map((score) => score.date.getTime()))
      .sort((a, b) => a - b);
    const dates = [...new Set(allDates)];

    const datasets = teamScoresHistory.map(({ team, scores }) => {
      let lastMatchedIndex = 0;
      const color = theme.colors[team.toLowerCase()][theme.fn.primaryShade()];

      return {
        label: 'Buzz donated',
        data: dates.map((date) => {
          let matchedIndex = scores.findIndex((x) => x.date.getTime() == date);
          if (matchedIndex !== -1) lastMatchedIndex = matchedIndex;
          else matchedIndex = lastMatchedIndex;

          const score = scores[matchedIndex]?.score;
          return { x: new Date(date), y: score };
        }),
        borderColor: color,
        backgroundColor: color,
      };
    });

    return datasets;
  }, [teamScoresHistory, theme.colors, theme.fn]);

  if (loading) return <PageLoader />;
  if (!eventData) return <NotFound />;

  const handleFocusDonateInput = () => inputRef.current?.focus();

  const equipped = eventCosmetic?.obtained && eventCosmetic?.equipped;
  const ended = eventData.endDate < new Date();

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
              backgroundImage: eventData.coverImage
                ? `url(${getEdgeUrl(eventData.coverImage, { width: 1600 })})`
                : undefined,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'top',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              aspectRatio: '3',
              overflow: 'hidden',

              [theme.fn.smallerThan('sm')]: {
                aspectRatio: '1',
              },
            })}
          >
            <Stack
              spacing={0}
              pt={60}
              pb="sm"
              px="md"
              sx={{
                width: '100%',
                background: 'linear-gradient(transparent, rgba(0, 0, 0, 0.6))',
              }}
            >
              <Title color="white" className="hide-mobile">
                {eventData.title}
              </Title>
              <Group spacing="xs" position="apart">
                <Text color="white" size="sm" className="hide-mobile">
                  {formatDate(eventData.startDate, 'MMMM D, YYYY')} -{' '}
                  {formatDate(eventData.endDate, 'MMMM D, YYYY')}
                </Text>
                {eventData.coverImageUser && (
                  <Text color="white" size="xs">
                    Banner created by{' '}
                    <Text
                      component={NextLink}
                      href={`/user/${eventData.coverImageUser}`}
                      td="underline"
                    >
                      {eventData.coverImageUser}
                    </Text>
                  </Text>
                )}
              </Group>
            </Stack>
          </Paper>
          <Stack className="show-mobile" spacing={0} mt={-40}>
            <Title sx={{ fontSize: '28px' }}>{eventData.title}</Title>
            <Text size="sm">
              {formatDate(eventData.startDate, 'MMMM D, YYYY')} -{' '}
              {formatDate(eventData.endDate, 'MMMM D, YYYY')}
            </Text>
          </Stack>
          {!equipped && !ended && <WelcomeCard event={event} about={aboutText} />}
          <CharitySection visible={!equipped && !ended} partners={partners} />
          <Grid gutter={48}>
            {eventCosmetic?.cosmetic && equipped && (
              <>
                <Grid.Col xs={12} sm="auto" order={ended ? 3 : undefined}>
                  <Card className={classes.card} py="xl" px="lg" radius="lg" h="100%">
                    <HolidayFrame
                      cosmetic={eventCosmetic.cosmetic}
                      data={cosmeticData}
                      force
                      animated
                    />
                    <Stack spacing={0} align="center" mt="lg" mb={theme.spacing.lg}>
                      <Text size="xl" weight={590}>
                        Your Garland
                      </Text>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'flex-end',
                        }}
                      >
                        <Lightbulb color={userTeam} size={48} transform="rotate(180)" animated />
                        <Text size={80} weight={590} color={userTeam} lh="70px">
                          {cosmeticData?.lights ?? 0}
                        </Text>
                        <Text size={32} weight={590} color="dimmed">
                          / 31
                        </Text>
                      </div>
                      <Text size="sm" weight={500} color={userTeam} tt="capitalize" mt={5}>
                        {userTeam} Team
                      </Text>
                    </Stack>
                    {eventCosmetic.available && !ended && (
                      <Stack spacing="sm" w="100%">
                        <Button
                          component={NextLink}
                          href="/posts/create"
                          color="gray"
                          variant="filled"
                          radius="xl"
                          fullWidth
                        >
                          <Group spacing={4} noWrap>
                            <IconBulb size={18} />
                            Earn more lights
                          </Group>
                        </Button>
                        <Button
                          color="gray"
                          variant="filled"
                          radius="xl"
                          onClick={handleFocusDonateInput}
                          fullWidth
                        >
                          <Group spacing={4} noWrap>
                            <IconBolt size={18} />
                            Make them brighter
                          </Group>
                        </Button>
                      </Stack>
                    )}
                  </Card>
                </Grid.Col>
                <Grid.Col xs={12} sm="auto" order={ended ? 3 : undefined}>
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
                          Total Team Donations
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
                            Spirit Bank
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
                                  <Text size="xl" weight={590}>
                                    {teamScore.rank}
                                  </Text>
                                  <Lightbulb
                                    variant="star"
                                    color={color}
                                    brightness={brightness}
                                    size={32}
                                    animated
                                  />
                                  <Text size="xl" weight={590} tt="capitalize" color={color}>
                                    {color} Team
                                  </Text>
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
                    </Stack>
                  </Card>
                </Grid.Col>
                {!ended && (
                  <Grid.Col span={12} mt={-40}>
                    <Text size="md" color="dimmed" ta="center">
                      You have{' '}
                      <Text component="span" weight={500} td="underline">
                        <Countdown endTime={resetTime} />
                      </Text>{' '}
                      to earn your light and to claim the top position for your team for the day.
                    </Text>
                  </Grid.Col>
                )}
                {/* <Grid.Col xs={12} sm="auto">
                  <Card
                    className={classes.card}
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
                      <Button
                        component={NextLink}
                        href={`/leaderboard/${event}:${userTeam}`}
                        color="gray"
                        radius="xl"
                        fullWidth
                      >
                        <Group spacing={4} noWrap>
                          <IconClipboard size={18} />
                          Team leaderboard
                        </Group>
                      </Button>
                      <Button
                        color="gray"
                        variant="filled"
                        radius="xl"
                        onClick={handleFocusDonateInput}
                        fullWidth
                      >
                        <Group spacing={4} noWrap>
                          <IconBolt size={18} />
                          Boost your rank
                        </Group>
                      </Button>
                    </Stack>
                  </Card>
                </Grid.Col> */}
              </>
            )}
            <Grid.Col span={12} order={ended ? 1 : undefined}>
              <SectionCard
                title={
                  ended ? (
                    <Group spacing={4}>
                      <CurrencyIcon currency={Currency.BUZZ} size={32} />
                      <Text>
                        {abbreviateNumber(totalTeamScores).toUpperCase()} Buzz donated to charity!
                      </Text>
                    </Group>
                  ) : (
                    'Spirit Bank History'
                  )
                }
                subtitle={
                  ended
                    ? `Thank you to everybody who participated in the ${eventData.title} event! Here are the final results`
                    : 'See how your team is doing. Have the most Buzz banked at the end to get a shiny new badge!'
                }
              >
                {equipped && !ended && <DonateInput event={event} ref={inputRef} />}
                {loadingHistory ? (
                  <Center py="xl">
                    <Loader variant="bars" />
                  </Center>
                ) : (
                  <Stack spacing={40} w="100%" align="center">
                    <Line options={options} data={{ datasets }} />
                    <Group spacing="md">
                      {teamScores.length > 0 &&
                        teamScores.map((teamScore) => (
                          <Group key={teamScore.team} spacing={4} noWrap>
                            <ThemeIcon color={teamScore.team.toLowerCase()} radius="xl" size={12}>
                              {null}
                            </ThemeIcon>
                            <Text
                              size="xs"
                              color={teamScore.team.toLowerCase()}
                              transform="uppercase"
                              weight={500}
                              lineClamp={1}
                            >
                              {teamScore.team}
                            </Text>
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
            <Grid.Col span={12} order={ended ? 2 : undefined}>
              <EventRewards event={event} />
            </Grid.Col>
          </Grid>
          <EventContributors event={event} endDate={eventData.endDate} />
          {(equipped || ended) && (
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
                  About The Challenge
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
              <CharitySection visible partners={partners} />
            </>
          )}
        </Stack>
      </Container>
    </>
  );
}

const useStyles = createStyles((theme) => ({
  card: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
  },
}));

const DonateInput = forwardRef<HTMLInputElement, { event: string }>(({ event }, ref) => {
  const [amount, setAmount] = useState<number>();

  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance: number) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
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
        rightSectionWidth="25%"
        hideControls
      />
      <Button color="yellow.7" loading={donating} onClick={handleSubmit}>
        Donate Buzz
      </Button>
    </Group>
  );
});
DonateInput.displayName = 'DonateInput';

const CharitySection = ({ visible, partners }: { visible: boolean; partners: EventPartners }) => {
  const { classes } = useCharityStyles();
  if (!visible) return null;

  return (
    <>
      <HeroCard
        title={<JdrfLogo width={145} height={40} />}
        description="All Buzz purchased and donated to Team Spirit Banks will be given to the global charity, the Juvenile Diabetes Research Foundation. Want to contribute to the cause without competing? [Donate here!](https://www2.jdrf.org/site/TR?fr_id=9410&pg=personal&px=13945459)"
        imageUrl="https://www.jdrf.org/wp-content/uploads/2023/02/d-b-1-800x474-1.png"
        externalLink="https://www.jdrf.org/"
      />
      <SectionCard
        title="Matching Partners"
        subtitle="Each partner will match the Buzz amount donated by the end of the month."
      >
        <div className={classes.partnerGrid}>
          {partners?.map((partner, index) => (
            <a
              key={index}
              className={classes.partner}
              href={partner.url}
              target="_blank"
              rel="noreferrer"
            >
              <div className={classes.partnerLogo}>
                <EdgeMedia src={partner.image} alt={`${partner.title} logo`} width={120} />
              </div>
              <Stack spacing={0} align="center">
                <Text size={20} weight={600}>
                  {partner.title}
                </Text>
                <Text size="xs" color="dimmed">
                  Matching ⚡{abbreviateNumber(partner.amount)}
                </Text>
              </Stack>
            </a>
          ))}
        </div>
        <Group position="center">
          <Button
            component="a"
            size="md"
            variant="light"
            radius="xl"
            sx={{ alignSelf: 'flex-start' }}
            rightIcon={<IconChevronRight />}
            href="/forms/matching-partner"
            target="_blank"
          >
            Become a partner
          </Button>
        </Group>
      </SectionCard>
    </>
  );
};

const useCharityStyles = createStyles((theme) => ({
  partnerGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    width: '100%',
    gap: theme.spacing.lg,
    [theme.fn.largerThan('xs')]: {
      gridTemplateColumns: 'repeat(3, 1fr)',
    },
    [theme.fn.largerThan('sm')]: {
      gridTemplateColumns: 'repeat(4, 1fr)',
    },
  },
  partnerLogo: {
    backgroundColor: theme.colors.dark[7],
    borderRadius: 30,
    width: 120,
    height: 120,
    img: { objectFit: 'cover', objectPosition: 'left', width: '100%' },
    overflow: 'hidden',
  },
  partner: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textDecoration: 'none !important',
    color: 'inherit !important',
    gap: theme.spacing.xs,
  },
}));
