import {
  Anchor,
  Button,
  Card,
  Center,
  Container,
  Divider,
  getPrimaryShade,
  Grid,
  Group,
  Loader,
  NumberInput,
  Paper,
  Popover,
  Stack,
  Text,
  ThemeIcon,
  Title,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { IconBolt, IconBulb, IconChevronRight } from '@tabler/icons-react';
import type { ChartOptions } from 'chart.js';
import {
  CategoryScale,
  Chart as ChartJS,
  LinearScale,
  LineElement,
  PointElement,
  TimeScale,
  Tooltip as ChartTooltip,
} from 'chart.js';
import 'chartjs-adapter-dayjs-4/dist/chartjs-adapter-dayjs-4.esm';
import dayjs from '~/shared/utils/dayjs';
import type { InferGetServerSidePropsType } from 'next';
import Image from 'next/image';
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
import type { EventPartners } from '~/components/Events/events.utils';
import { useMutateEvent, useQueryEvent } from '~/components/Events/events.utils';
import { SectionCard } from '~/components/Events/SectionCard';
import { WelcomeCard } from '~/components/Events/WelcomeCard';
import { HeroCard } from '~/components/HeroCard/HeroCard';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link, NextLink } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { env } from '~/env/client';
import { constants } from '~/server/common/constants';
import { eventSchema } from '~/server/schema/event.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';
import classes from './[slug].module.scss';

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
  "Your challenge is to participate in daily holiday challenges throughout the rest of December. Once CivBot has approved your entry, you'll receive a new lightbulb on your garland in the team color randomly assigned to you when you join the challenge. The more bulbs you collect, the more badges you can win! The more Buzz donated to your team bank, the brighter your lights shine. The brighter your lights shine, the bigger your bragging rights. The team with the brightest lights and highest Spirit Bank score wins a shiny new animated badge!";

const learnMore: string | undefined = 'https://civitai.com/articles/9731';

export default function EventPageDetails({
  event,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
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
      const color = theme.colors[team.toLowerCase()][getPrimaryShade(theme, colorScheme)];

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
  }, [teamScoresHistory, theme.colors, colorScheme]);

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
        <Stack gap={48}>
          <Paper
            radius="md"
            className="flex aspect-square flex-col justify-end overflow-hidden @sm:aspect-[3]"
            style={{
              backgroundImage: eventData.coverImage
                ? `url(${getEdgeUrl(eventData.coverImage, { width: 1600 })})`
                : undefined,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'bottom left',
              backgroundSize: 'cover',
            }}
          >
            <Stack
              gap={0}
              pt={60}
              pb="sm"
              px="md"
              style={{
                width: '100%',
                background: 'linear-gradient(transparent, rgba(0, 0, 0, 0.6))',
              }}
            >
              <Title c="white" className="hide-mobile">
                {eventData.title}
              </Title>
              <Group gap="xs" justify="space-between">
                <Text c="white" size="sm" className="hide-mobile">
                  {formatDate(eventData.startDate, 'MMMM D, YYYY')} -{' '}
                  {formatDate(eventData.endDate, 'MMMM D, YYYY')}
                </Text>
                {eventData.coverImageUser && (
                  <Text c="white" size="xs">
                    Banner created by{' '}
                    <Text
                      component={Link}
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
          <Stack className="show-mobile" gap={0} mt={-40}>
            <Title fz="28px">{eventData.title}</Title>
            <Text size="sm">
              {formatDate(eventData.startDate, 'MMMM D, YYYY')} -{' '}
              {formatDate(eventData.endDate, 'MMMM D, YYYY')}
            </Text>
          </Stack>
          {!equipped && !ended && (
            <WelcomeCard event={event} about={aboutText} learnMore={learnMore} />
          )}
          <CharitySection visible={!equipped && !ended} partners={partners} />
          <Grid gutter={48}>
            {eventCosmetic?.cosmetic && equipped && (
              <>
                <Grid.Col span={{ base: 12, sm: 'auto' }} order={ended ? 3 : undefined}>
                  <Card
                    className="flex flex-col items-center justify-center bg-gray-0 dark:bg-dark-6"
                    py="xl"
                    px="lg"
                    radius="lg"
                    h="100%"
                  >
                    <HolidayFrame
                      cosmetic={eventCosmetic.cosmetic}
                      data={cosmeticData}
                      force
                      animated
                    />
                    <Stack gap={0} align="center" mt="lg" mb={theme.spacing.lg}>
                      <Text size="xl" fw={590}>
                        Your Garland
                      </Text>
                      <div className="flex items-end">
                        <Lightbulb color={userTeam} size={48} transform="rotate(180)" animated />
                        <Text fz={80} fw={590} c={userTeam} lh="70px">
                          {cosmeticData?.lights ?? 0}
                        </Text>
                        <Text fz={32} fw={590} c="dimmed">
                          / 12
                        </Text>
                      </div>
                      <Text size="sm" fw={500} c={userTeam} tt="capitalize" mt={5}>
                        {userTeam} Team
                      </Text>
                      <Popover withinPortal shadow="md">
                        <Popover.Target>
                          <Text size="xs" c="dimmed" td="underline" className="cursor-pointer">
                            Missing a Bulb?
                          </Text>
                        </Popover.Target>
                        <Popover.Dropdown maw={300} p="sm">
                          <Text size="xs" c="dimmed">
                            {`CivBot reviews challenge entries every 10 minutes and will give you your
                            bulb for the day after approving your entry. If you haven't received it,
                            wait, then make sure your entry was approved and refresh this page.`}
                          </Text>
                        </Popover.Dropdown>
                      </Popover>
                    </Stack>
                    {eventCosmetic.available && !ended && (
                      <Stack gap="sm" w="100%">
                        <Button
                          component={Link}
                          href="/challenges"
                          color="gray"
                          variant="filled"
                          radius="xl"
                          fullWidth
                          disabled={cosmeticData?.lights >= 12}
                        >
                          <Group gap={4} wrap="nowrap">
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
                          <Group gap={4} wrap="nowrap">
                            <IconBolt size={18} />
                            Make them brighter
                          </Group>
                        </Button>
                      </Stack>
                    )}
                  </Card>
                </Grid.Col>
                <Grid.Col span={{ base: 12, sm: 'auto' }} order={ended ? 3 : undefined}>
                  <Card
                    py="xl"
                    px="lg"
                    radius="lg"
                    h="100%"
                    style={{ display: 'flex', alignItems: 'center' }}
                  >
                    <Stack w="100%">
                      <Stack gap={0} align="center">
                        <Text size="sm" fw={590}>
                          Total Team Donations
                        </Text>
                        <Group gap={4} wrap="nowrap">
                          <CurrencyIcon currency={Currency.BUZZ} />
                          <Text fz={32} fw={590} style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {numberWithCommas(totalTeamScores)}
                          </Text>
                        </Group>
                      </Stack>
                      <Stack gap={8}>
                        <Group gap={8} className="grow" justify="space-between">
                          <Text size="sm" fw={590}>
                            Team Rank
                          </Text>
                          <Text size="sm" fw={590}>
                            Spirit Bank
                          </Text>
                        </Group>
                        {teamScores.map((teamScore) => {
                          const color = teamScore.team.toLowerCase();
                          const brightness =
                            (teamScores.length - teamScore.rank + 1) / teamScores.length;

                          return (
                            <Fragment key={teamScore.team}>
                              <Group gap={8} className="grow" justify="space-between">
                                <Group gap={4} wrap="nowrap">
                                  <Text size="xl" fw={590}>
                                    {teamScore.rank}
                                  </Text>
                                  <Lightbulb
                                    color={color}
                                    brightness={brightness}
                                    size={32}
                                    animated
                                  />
                                  <Text size="xl" fw={590} tt="capitalize" c={color}>
                                    {color} Team
                                  </Text>
                                </Group>
                                <Group gap={4} wrap="nowrap">
                                  <CurrencyIcon currency={Currency.BUZZ} />
                                  <Text
                                    size="xl"
                                    fw={590}
                                    style={{ fontVariantNumeric: 'tabular-nums' }}
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
                    <Text size="md" c="dimmed" ta="center">
                      You have{' '}
                      <Text component="span" fw={500} td="underline">
                        <Countdown endTime={resetTime} />
                      </Text>{' '}
                      to earn your light and to claim the top position for your team for the day.
                    </Text>
                  </Grid.Col>
                )}
                {/* <Grid.Col span={{ base: 12, sm: 'auto' }}>
                  <Card
                    className={classes.card}
                    py="xl"
                    px="lg"
                    radius="lg"
                    h="100%"
                    style={{ display: 'flex', alignItems: 'center' }}
                  >
                    <Stack align="center" w="100%" gap="lg">
                      <Lightbulb variant="star" color={userTeam} size={80} />
                      <Stack gap={4} align="center">
                        <Text size={24} fw={600} align="center" inline>
                          Your rank in {userTeam} team
                        </Text>
                        {loadingUserRank ? (
                          <Loader type="bars" />
                        ) : (
                          <Text size={96} fw="bold" align="center" c={userTeam} inline>
                            {userRank?.toLocaleString()}
                          </Text>
                        )}
                      </Stack>
                      <Button
                        component={Link}
                        href={`/leaderboard/${event}:${userTeam}`}
                        color="gray"
                        radius="xl"
                        fullWidth
                      >
                        <Group gap={4} wrap="nowrap">
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
                        <Group gap={4} wrap="nowrap">
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
                    <Group gap={4}>
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
                    <Loader type="bars" />
                  </Center>
                ) : (
                  <Stack gap={40} w="100%" align="center">
                    <Line options={options} data={{ datasets }} />
                    <Group gap="md">
                      {teamScores.length > 0 &&
                        teamScores.map((teamScore) => (
                          <Group key={teamScore.team} gap={4} wrap="nowrap">
                            <ThemeIcon color={teamScore.team.toLowerCase()} radius="xl" size={12}>
                              {null}
                            </ThemeIcon>
                            <Text
                              size="xs"
                              color={teamScore.team.toLowerCase()}
                              tt="uppercase"
                              fw={500}
                              lineClamp={1}
                            >
                              {teamScore.team}
                            </Text>
                            <Text size="xs" c="dimmed" tt="uppercase" fw={500} lineClamp={1}>
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
              <Stack gap={20}>
                <Title order={2} ta="center" className="text-3xl @sm:text-6xl">
                  About The Challenge
                </Title>
                <Text c="dimmed" className="text-lg @sm:text-2xl">
                  {aboutText}
                </Text>
                {learnMore && (
                  <Anchor component={NextLink} href={learnMore} className="text-lg @sm:text-2xl">
                    Learn more
                  </Anchor>
                )}
              </Stack>
              <CharitySection visible partners={partners} />
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
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more Buzz to perform this action.`,
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
    <Group gap={8} wrap="nowrap">
      <NumberInput
        ref={ref}
        placeholder="Your donation"
        leftSection={<CurrencyIcon currency={Currency.BUZZ} size={16} />}
        value={amount}
        onChange={(value) => setAmount(typeof value === 'number' ? value : undefined)}
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
  if (!visible) return null;

  return (
    <>
      <HeroCard
        title={
          <Image
            src="/images/event/holiday2024/ahh_logo.png"
            alt="All Hands and Hearts"
            width={206}
            height={50}
          />
        }
        description="All Buzz purchased and donated to Team Spirit Banks will be given to the global charity, All Hands and Hearts. Want to contribute to the cause without competing? [Donate here!](https://give.allhandsandhearts.org/campaign/650534/donate)"
        imageUrl="https://www.allhandsandhearts.org/wp-content/uploads/2019/12/400_1147_PR_Construction_Volunteer_5416_18.02.15-460x295.jpg"
        externalLink="https://www.allhandsandhearts.org/"
      />
      <SectionCard
        title="Matching Organizations"
        subtitle="These organizations will match the Buzz amount donated by the end of the month."
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
              <Stack gap={0} align="center">
                <Text fz={20} fw={600}>
                  {partner.title}
                </Text>
                <Text size="xs" c="dimmed">
                  Matching ⚡{abbreviateNumber(partner.amount)}
                </Text>
              </Stack>
            </a>
          ))}
        </div>
        <Group justify="center">
          <Button
            component="a"
            size="md"
            variant="light"
            radius="xl"
            style={{ alignSelf: 'flex-start' }}
            rightSection={<IconChevronRight />}
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
