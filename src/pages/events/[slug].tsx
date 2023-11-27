import {
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Chip,
  CloseButton,
  Container,
  Divider,
  Grid,
  Group,
  Loader,
  Modal,
  ModalProps,
  Paper,
  Stack,
  Text,
  Title,
  createStyles,
  useMantineTheme,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import { IconBulb } from '@tabler/icons-react';
import {
  CategoryScale,
  Chart as ChartJS,
  Tooltip as ChartTooltip,
  LineElement,
  LinearScale,
  PointElement,
} from 'chart.js';
import dayjs from 'dayjs';
import { InferGetServerSidePropsType } from 'next';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { z } from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { Countdown } from '~/components/Countdown/Countdown';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { HolidayFrame } from '~/components/Decorations/HolidayFrame';
import { Lightbulb } from '~/components/Decorations/Lightbulb';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useMutateEvent, useQueryEvent } from '~/components/Events/events.utils';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { UserBuzz } from '~/components/User/UserBuzz';
import { env } from '~/env/client.mjs';
import { Form, InputChipGroup, InputNumber, useForm } from '~/libs/form';
import { constants } from '~/server/common/constants';
import { eventSchema } from '~/server/schema/event.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate, stripTime } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';

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
const options = {
  aspectRatio: 2.5,
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

  const [opened, setOpened] = useState(false);

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

  const userTeam = (eventCosmetic.cosmetic?.data as { type: string; color: string })?.color;
  const teamColorTheme = theme.colors[userTeam.toLowerCase()];
  const totalTeamScores = teamScores.reduce((acc, teamScore) => acc + teamScore.score, 0);
  const cosmeticData = eventCosmetic.data as { lights: number; lightUpgrades: number };

  const labels = Array.from(
    new Set(
      teamScoresHistory
        .flatMap((teamScore) => teamScore.scores.map((score) => score.date))
        .sort((a, b) => a.getTime() - b.getTime())
        .map((date) => formatDate(stripTime(date), 'MMM-DD'))
    )
  );

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
              backgroundImage: eventData?.coverImage ? `url(${eventData.coverImage})` : undefined,
              backgroundPosition: 'top',
            }}
          >
            <Center w="100%" h="100%" style={{ backgroundColor: 'rgba(0, 0, 0, 0.3)' }}>
              <Title color="white" align="center">
                {eventData?.title}
              </Title>
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
                    <HolidayFrame
                      cosmetic={eventCosmetic.cosmetic}
                      lights={cosmeticData.lights ?? 0}
                    />
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
                  {loadingHistory ? (
                    <Center py="xl">
                      <Loader variant="bars" />
                    </Center>
                  ) : (
                    <Line
                      options={options}
                      data={{
                        labels,
                        datasets: teamScoresHistory.map(({ team, scores }) => {
                          const color = theme.colors[team.toLowerCase()][theme.fn.primaryShade()];
                          return {
                            label: 'Buzz donated',
                            data: scores.map((score) => score.score),
                            borderColor: color,
                            backgroundColor: color,
                          };
                        }),
                      }}
                    />
                  )}
                  <Button variant="filled" color="gray" radius="xl" onClick={() => setOpened(true)}>
                    <Group spacing={4}>
                      <CurrencyIcon currency={Currency.BUZZ} size={18} />
                      Boost your team
                    </Group>
                  </Button>
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
      <DonationModal event={event} opened={opened} onClose={() => setOpened(false)} />
    </>
  );
}

// TODO.manuel: This all comes from the SendTipModal.tsx file and adjusted accordingly
// We can consider moving this to a separate file and importing it here
const useStyles = createStyles((theme) => ({
  presetCard: {
    position: 'relative',
    width: '100%',
    borderRadius: theme.radius.sm,
    border: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
    }`,

    '&:hover:not([disabled])': {
      borderColor: theme.colors.blue[6],
    },

    '&[disabled]': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },

  sendIcon: {
    backgroundColor: theme.colors.blue[theme.fn.primaryShade()],
    color: theme.white,
    borderTopRightRadius: theme.radius.sm,
    borderBottomRightRadius: theme.radius.sm,
  },

  // Chip styling
  label: {
    padding: `0 ${theme.spacing.xs}px`,

    '&[data-checked]': {
      border: `2px solid ${theme.colors.accent[5]}`,
      color: theme.colors.accent[5],

      '&[data-variant="filled"], &[data-variant="filled"]:hover': {
        backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.white,
      },
    },
  },

  // Chip styling
  iconWrapper: {
    display: 'none',
  },

  chipGroup: {
    gap: 8,

    [theme.fn.smallerThan('sm')]: {
      gap: theme.spacing.md,
    },
  },

  actions: {
    [theme.fn.smallerThan('sm')]: {
      flexDirection: 'column',
      position: 'absolute',
      bottom: 0,
      left: 0,
      width: '100%',
      padding: theme.spacing.md,
    },
  },

  cancelButton: {
    [theme.fn.smallerThan('sm')]: {
      width: '100%',
      order: 2,
    },
  },

  submitButton: {
    [theme.fn.smallerThan('sm')]: {
      width: '100%',
      order: 1,
    },
  },
}));

const presets = [
  { label: 'xs', amount: '100' },
  { label: 'sm', amount: '200' },
  { label: 'md', amount: '500' },
  { label: 'lg', amount: '1000' },
];

const schema = z
  .object({
    // Using string here since chip component only works with string values
    amount: z.string(),
    customAmount: z.number().positive().min(0).max(constants.buzz.maxTipAmount).optional(),
  })
  .refine((data) => data.amount !== '-1' || data.customAmount, {
    message: 'Please enter a valid amount',
    path: ['customAmount'],
  });

function DonationModal({ event, opened, onClose, ...modalProps }: ModalProps & { event: string }) {
  const { classes } = useStyles();
  const { balance } = useBuzz();

  const form = useForm({ schema, defaultValues: { amount: presets[0].amount } });

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

  const handleSubmit = (data: z.infer<typeof schema>) => {
    const { customAmount } = data;
    const amount = Number(data.amount);
    const amountToSend = Number(amount) === -1 ? customAmount ?? 0 : Number(amount);
    const performTransaction = async () => {
      try {
        await donate({ event, amount: amountToSend });
        onClose();
      } catch (e) {
        const error = e as Error;
        showErrorNotification({ title: 'Unable to donate', error });
      }
    };

    conditionalPerformTransaction(amountToSend, performTransaction);
  };

  const [amount, customAmount] = form.watch(['amount', 'customAmount']);
  const amountToSend = Number(amount) === -1 ? customAmount : Number(amount);

  return (
    <Modal opened={opened} onClose={onClose} withCloseButton={false} {...modalProps}>
      <Stack spacing="md">
        <Group position="apart" noWrap>
          <Text size="lg" weight={700}>
            Donate
          </Text>
          <Group spacing="sm" noWrap>
            <Badge
              radius="xl"
              variant="filled"
              h="auto"
              py={4}
              px={12}
              sx={(theme) => ({
                backgroundColor:
                  theme.colorScheme === 'dark' ? theme.fn.rgba('#000', 0.31) : theme.colors.gray[0],
              })}
            >
              <Group spacing={4} noWrap>
                <Text size="xs" color="dimmed" transform="capitalize" weight={600}>
                  Available Buzz
                </Text>
                <UserBuzz iconSize={16} textSize="sm" withTooltip />
              </Group>
            </Badge>
            <CloseButton radius="xl" iconSize={22} onClick={onClose} />
          </Group>
        </Group>
        <Divider mx="-lg" />
        <Text>How much buzz do you want to donate?</Text>
        <Form form={form} onSubmit={handleSubmit} style={{ position: 'static' }}>
          <Stack spacing="md">
            <InputChipGroup className={classes.chipGroup} name="amount" spacing={8}>
              {presets.map((preset) => (
                <Chip
                  classNames={classes}
                  variant="filled"
                  key={preset.label}
                  value={preset.amount}
                >
                  <Group spacing={4}>
                    {preset.amount === amount && (
                      <CurrencyIcon currency={Currency.BUZZ} size={16} />
                    )}
                    {preset.amount}
                  </Group>
                </Chip>
              ))}
              <Chip classNames={classes} variant="filled" value="-1">
                <Group spacing={4}>
                  {amount === '-1' && <CurrencyIcon currency={Currency.BUZZ} size={16} />}
                  Other
                </Group>
              </Chip>
            </InputChipGroup>
            {amount === '-1' && (
              <InputNumber
                name="customAmount"
                placeholder="Your donation. Minimum 50 BUZZ"
                variant="filled"
                rightSectionWidth="10%"
                min={1}
                max={balance}
                disabled={donating}
                icon={<CurrencyIcon currency="BUZZ" size={16} />}
                parser={(value) => value?.replace(/\$\s?|(,*)/g, '')}
                formatter={(value) =>
                  value && !Number.isNaN(parseFloat(value))
                    ? value.replace(/\B(?<!\.\d*)(?=(\d{3})+(?!\d))/g, ',')
                    : ''
                }
                hideControls
              />
            )}
            <Group className={classes.actions} position="right" mt="xl">
              <Button
                className={classes.cancelButton}
                variant="light"
                color="gray"
                onClick={onClose}
              >
                Cancel
              </Button>
              <BuzzTransactionButton
                label="Donate"
                className={classes.submitButton}
                buzzAmount={amountToSend ?? 0}
                disabled={(amountToSend ?? 0) === 0}
                loading={donating}
                color="yellow.7"
                type="submit"
              />
            </Group>
          </Stack>
        </Form>
      </Stack>
    </Modal>
  );
}
