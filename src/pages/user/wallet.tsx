import {
  Button,
  ButtonProps,
  Center,
  Container,
  createStyles,
  Divider,
  Grid,
  Group,
  keyframes,
  Loader,
  Paper,
  RingProgress,
  ScrollArea,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import {
  IconArrowRight,
  IconBarbell,
  IconBolt,
  IconBrush,
  IconCoin,
  IconCoins,
  IconHighlight,
  IconInfoCircle,
  IconMoneybag,
  IconShoppingBag,
  IconShoppingCart,
  IconUsers,
} from '@tabler/icons-react';
import {
  CategoryScale,
  Chart as ChartJS,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip as ChartTooltip,
} from 'chart.js';
import React, { MouseEvent, useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import { useQueryBuzzAccount } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { UserBuzz } from '~/components/User/UserBuzz';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { TransactionType } from '~/server/schema/buzz.schema';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { useGenerationStore } from '~/store/generation.store';
import { formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ChartTooltip);

const options = {
  aspectRatio: 2.5,
  plugins: {
    legend: {
      display: false,
    },
    title: {
      display: false,
    },
  },
};

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    const features = getFeatureFlags({ user: session?.user });
    if (!features.buzz) {
      return { notFound: true };
    }
  },
});

const moveBackground = keyframes({
  '0%': {
    backgroundPosition: '0% 50%',
  },
  '50%': {
    backgroundPosition: '100% 50%',
  },
  '100%': {
    backgroundPosition: '0% 50%',
  },
});

const pulse = keyframes({
  '0%': {
    stroke: '#FFD43B',
    opacity: 1,
  },
  '50%': {
    stroke: '#F59F00',
    opacity: 0.7,
  },
  '100%': {
    stroke: '#F08C00',
    opacity: 1,
  },
});

const useStyles = createStyles((theme) => ({
  lifetimeBuzzContainer: {
    border: `2px solid ${theme.colors.yellow[7]}`,
    background: theme.fn.linearGradient(45, theme.colors.yellow[4], theme.colors.yellow[1]),
    animation: `${moveBackground} 5s ease infinite`,
    backgroundSize: '200% 200%',
  },
  lifetimeBuzzBadge: {
    background: theme.colors.dark[6],
    borderRadius: '22px',
    padding: '10px 20px',
  },
  tileCard: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],
  },
  featureCard: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],
  },
  lifetimeBuzz: {
    animation: `${pulse} 1s ease-in-out infinite`,
  },
}));

export default function UserWallet() {
  const currentUser = useCurrentUser();
  const { classes, theme } = useStyles();

  const { data: { transactions = [] } = {}, isLoading } = trpc.buzz.getUserTransactions.useQuery({
    limit: 200,
  });
  const { lifetimeBalance = 0 } = useQueryBuzzAccount({
    enabled: !!currentUser,
  });

  const transactionsReversed = useMemo(() => [...(transactions ?? [])].reverse(), [transactions]);

  const starterBuzzAmount = (transactions ?? []).reduce((acc, transaction) => {
    return acc - transaction.amount;
  }, currentUser?.balance ?? 0);

  const items: Record<string, number> = useMemo(() => {
    if (!transactions) return {};

    let start = starterBuzzAmount;

    return transactionsReversed.reduce((acc, transaction) => {
      const updated = {
        ...acc,
        [formatDate(transaction.date, 'DD/MM/YYYY')]: start + transaction.amount,
      };

      start += transaction.amount;

      return updated;
    }, {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions]);

  const dateCount = Object.keys(items).length;
  // Last 7 days of data pretty much.
  const labels = Object.keys(items).slice(Math.max(0, dateCount - 7), dateCount);
  const data = Object.values(items).slice(Math.max(0, dateCount - 7), dateCount);

  return (
    <Container size="lg">
      <Stack spacing="xl">
        <Title order={1}>My Wallet</Title>

        {isLoading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : (
          <Grid>
            <Grid.Col xs={12} md={7}>
              <Stack h="100%">
                <Paper withBorder p="lg" radius="md" className={classes.tileCard}>
                  <Stack spacing={0}>
                    <Title order={3}>Current Buzz</Title>
                    <UserBuzz textSize="xl" user={currentUser} withAbbreviation={false} />
                  </Stack>
                  <Stack spacing="xs" mt="xl">
                    <Line
                      options={options}
                      data={{
                        labels,
                        datasets: [
                          {
                            label: 'Buzz Amount',
                            data,
                            borderColor: theme.colors.yellow[7],
                            backgroundColor: theme.colors.yellow[7],
                          },
                        ],
                      }}
                    />
                  </Stack>
                </Paper>
                <Paper
                  withBorder
                  radius="md"
                  p="xl"
                  className={classes.lifetimeBuzzContainer}
                  style={{ flex: 1, display: 'flex' }}
                >
                  <Group position="apart" style={{ flex: 1 }} noWrap>
                    <Title order={3} size={22} color="yellow.8">
                      Lifetime Buzz
                    </Title>
                    <Group className={classes.lifetimeBuzzBadge} spacing={2}>
                      <CurrencyIcon currency={Currency.BUZZ} size={24} />
                      {lifetimeBalance === null ? (
                        <Loader variant="dots" />
                      ) : (
                        <Text
                          size="xl"
                          style={{ fontSize: 32, fontWeight: 700, lineHeight: '24px' }}
                          color="yellow.7"
                          className={classes.lifetimeBuzz}
                        >
                          {numberWithCommas(lifetimeBalance ?? 0)}
                        </Text>
                      )}
                    </Group>
                  </Group>
                </Paper>
              </Stack>
            </Grid.Col>
            <Grid.Col xs={12} md={5}>
              <Paper
                withBorder
                p="lg"
                radius="md"
                h="100%"
                className={classes.tileCard}
                style={{ flex: 1 }}
              >
                <Stack spacing={0}>
                  <Title order={3}>Recent Transactions</Title>
                  <Text component="a" variant="link" href={`/user/transactions`} size="xs">
                    <Group spacing={2}>
                      <IconArrowRight size={18} />
                      <span>View all</span>
                    </Group>
                  </Text>
                  {transactions.length ? (
                    <ScrollArea.Autosize maxHeight={400} mt="md">
                      <Stack spacing={8}>
                        {transactions.map((transaction) => {
                          const { amount, date } = transaction;
                          const isDebit = amount < 0;

                          return (
                            <Stack key={date.toISOString()} spacing={4}>
                              <Group position="apart">
                                <Stack spacing={0}>
                                  <Text size="sm" weight="500">
                                    {TransactionType[transaction.type]}
                                  </Text>
                                  <Text size="xs">
                                    <DaysFromNow date={date} />
                                  </Text>
                                </Stack>
                                <Text color={isDebit ? 'red' : 'green'}>
                                  <Group spacing={2}>
                                    <IconBolt size={16} fill="currentColor" />
                                    <Text
                                      size="lg"
                                      sx={{ fontVariantNumeric: 'tabular-nums' }}
                                      span
                                    >
                                      {amount.toLocaleString()}
                                    </Text>
                                  </Group>
                                </Text>
                              </Group>
                            </Stack>
                          );
                        })}
                      </Stack>
                    </ScrollArea.Autosize>
                  ) : (
                    <Text color="dimmed" mt="md">
                      No transactions yet.
                    </Text>
                  )}
                </Stack>
              </Paper>
            </Grid.Col>
          </Grid>
        )}

        <EarningBuzz />
        <SpendingBuzz />
      </Stack>
    </Container>
  );
}

type FeatureCardProps = {
  title: string;
  description: string;
  icon: React.ReactNode;
  btnProps: ButtonProps & {
    href?: string;
    component?: 'a' | 'button';
    onClick?: (e: MouseEvent<HTMLElement>) => void;
  };
};

const EarningBuzz = () => {
  const { classes } = useStyles();
  const currentUser = useCurrentUser();
  const { data: rewards = [], isLoading } = trpc.user.userRewardDetails.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const data: (FeatureCardProps & { key: string })[] = [
    {
      key: 'referrals',
      icon: <IconUsers size={32} />,
      title: 'Referrals',
      description: 'You & your friends can earn more buzz!',
      btnProps: {
        href: '/user/referrals',
        children: 'Invite a friend',
      },
    },
    {
      key: 'bounties',
      icon: <IconMoneybag size={32} />,
      title: 'Bounties',
      description: 'Submit work to a bounty to win buzz',
      btnProps: {
        href: '/bounties',
        children: 'Learn more',
      },
    },
    {
      key: 'purchase',
      icon: <IconCoin size={32} />,
      title: 'Purchase',
      description: 'Purchase buzz directly',
      btnProps: {
        href: '/purchase/buzz',
        children: 'Buy now',
      },
    },
    {
      key: 'tips',
      icon: <IconCoins size={32} />,
      title: 'Get tipped',
      description: 'Create awesome content!',
      btnProps: {
        href: '/images',
        children: 'Learn more',
      },
    },
  ];

  return (
    <Stack spacing={20}>
      <Stack spacing={4}>
        <Title order={2}>Earning Buzz</Title>
        <Text>Need some buzz? Here&rsquo;s how you can earn it</Text>
      </Stack>
      <Grid gutter={20}>
        {data.map((item) => (
          <Grid.Col key={item.key} xs={12} md={3}>
            <FeatureCard {...item} />
          </Grid.Col>
        ))}
      </Grid>
      <Paper withBorder className={classes.tileCard} h="100%">
        <Stack p="md">
          <Title order={3}>Other ways you&rsquo;ll earn some buzz</Title>
          {isLoading && (
            <Center py="xl">
              <Loader />
            </Center>
          )}
          {!isLoading &&
            rewards.map((reward) => {
              const awardedAmountPercent =
                reward.cap && reward.awarded !== -1 ? reward.awarded / reward.cap : 0;

              return (
                <Stack key={reward.type} spacing={4}>
                  <Group position="apart">
                    <Group noWrap>
                      <Text>
                        <CurrencyBadge
                          w={100}
                          currency={Currency.BUZZ}
                          unitAmount={reward.awardAmount}
                        />{' '}
                        {reward.triggerDescription ?? reward.description}
                      </Text>
                      {reward.tooltip && (
                        <Tooltip label={reward.tooltip} maw={250} multiline withArrow>
                          <IconInfoCircle size={20} style={{ flexShrink: 0 }} />
                        </Tooltip>
                      )}
                    </Group>
                    {reward.cap && reward.awarded != -1 && (
                      <Group spacing={4}>
                        <Text color="dimmed" size="xs">
                          {reward.awarded}/{reward.cap.toLocaleString()} day
                        </Text>
                        <RingProgress
                          size={30}
                          thickness={9}
                          sections={[
                            {
                              value: awardedAmountPercent * 100,
                              color: awardedAmountPercent === 1 ? 'green' : 'yellow.7',
                            },
                          ]}
                        />
                      </Group>
                    )}
                  </Group>
                  <Divider mt="xs" />
                </Stack>
              );
            })}
        </Stack>
      </Paper>
    </Stack>
  );
};

const SpendingBuzz = () => {
  const open = useGenerationStore((state) => state.open);
  const data: (FeatureCardProps & { key: string })[] = [
    {
      key: 'train',
      icon: <IconBarbell size={32} />,
      title: 'Train',
      description: 'Simple per-minute pricing, in buzz',
      btnProps: {
        href: '/models/train',
        children: 'Train now',
        rightIcon: <IconArrowRight size={14} />,
      },
    },
    {
      key: 'generate',
      icon: <IconBrush size={32} />,
      title: 'Generate Images',
      description: 'Use any of our models to create',
      btnProps: {
        component: 'button',
        onClick: (e: MouseEvent<HTMLElement>) => {
          e.preventDefault();
          open();
        },
        children: 'Generate now',
        rightIcon: <IconArrowRight size={14} />,
      },
    },
    {
      key: 'tip',
      icon: <IconCoins size={32} />,
      title: 'Tip an artist',
      description: 'Support an artist you love!',
      btnProps: {
        href: '/images',
        children: 'View artists',
        rightIcon: <IconArrowRight size={14} />,
      },
    },
    {
      key: 'bounties',
      icon: <IconMoneybag size={32} />,
      title: 'Bounties',
      description: 'Submit work to a bounty to win buzz',
      btnProps: {
        href: '/bounties/create',
        children: 'Create a bounty',
        rightIcon: <IconArrowRight size={14} />,
      },
    },
    {
      key: 'showcase',
      icon: <IconHighlight size={32} />,
      title: 'Get showcased',
      description: 'Boost your model to our homepage',
      btnProps: {
        href: '/contact', // TODO.Justin: BuzzPage: Clickup form.
        children: 'Contact us',
        rightIcon: <IconArrowRight size={14} />,
      },
    },
    {
      key: 'merch',
      icon: <IconShoppingCart size={32} />,
      title: 'Shop merch',
      description: 'Tens of fun stickers to choose from...',
      btnProps: {
        disabled: true,
        children: 'COMING SOON',
      },
    },
    {
      key: 'badges',
      icon: <IconShoppingBag size={32} />,
      title: 'Shop badges',
      description: 'Make your profile stand out!',
      btnProps: {
        disabled: true,
        children: 'COMING SOON',
      },
    },
  ];

  return (
    <Stack spacing={20}>
      <Stack spacing={4}>
        <Title order={2}>Spending Buzz</Title>
        <Text>Got some buzz? Here&rsquo;s what you can do with it</Text>
      </Stack>
      <Grid gutter={20}>
        {data.map((item) => (
          <Grid.Col key={item.key} xs={12} md={3}>
            <FeatureCard {...item} />
          </Grid.Col>
        ))}
      </Grid>
    </Stack>
  );
};

const FeatureCard = ({ title, description, icon, btnProps }: FeatureCardProps) => {
  const { classes } = useStyles();

  return (
    <Paper withBorder className={classes.featureCard} h="100%">
      <Stack spacing={4} p="md" align="center" h="100%">
        <Center>{icon}</Center>
        <Text weight={500} size="xl">
          {title}
        </Text>
        <Text color="dimmed" align="center">
          {description}
        </Text>
        <Button component="a" mt="auto" w="100%" {...btnProps} />
      </Stack>
    </Paper>
  );
};
