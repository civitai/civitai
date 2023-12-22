import {
  Button,
  Card,
  Center,
  createStyles,
  Grid,
  Group,
  Loader,
  Paper,
  Skeleton,
  Stack,
  Text,
} from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import Link from 'next/link';
import { abbreviateNumber } from '~/utils/number-helpers';
import { useQueryEventContributors } from './events.utils';
import { CurrencyIcon } from '../Currency/CurrencyIcon';
import { Currency } from '@prisma/client';
import { UserAvatar } from '../UserAvatar/UserAvatar';
import dayjs from 'dayjs';
import { formatDate } from '~/utils/date-helpers';
import { Countdown } from '~/components/Countdown/Countdown';

const resetTime = dayjs().endOf('hour').toDate();
const startTime = dayjs().startOf('hour').toDate();

export function EventContributors({ event, endDate }: { event: string; endDate: Date }) {
  const { contributors, loading } = useQueryEventContributors({ event });
  const { classes } = useStyles();

  const topDayContributors = contributors?.day.slice(0, 4) ?? [];
  const topAllTimeContributors = contributors?.allTime.slice(0, 4) ?? [];
  const topTeamContributors = Object.entries(contributors?.teams ?? {}).map(
    ([team, users]) => [team, users.slice(0, 4)] as const
  );

  const ended = resetTime > endDate;

  return (
    <Grid gutter={48}>
      <Grid.Col xs={12} sm="auto">
        <Card p={32} radius="lg" h="100%" className={classes.card}>
          <Stack spacing="xl">
            <Stack spacing={0}>
              <Text size={32} weight="bold">
                Top Donors All Time
              </Text>
              {!ended && (
                <Text size="xs" color="dimmed">
                  As of {formatDate(startTime, 'h:mma')}. Refreshes in:{' '}
                  <Countdown endTime={resetTime} format="short" />
                </Text>
              )}
            </Stack>
            {loading ? (
              Array.from({ length: 4 }).map((_, index) => (
                <Group key={index} spacing={8} noWrap>
                  <Skeleton height={40} circle />
                  <Skeleton height={44} />
                </Group>
              ))
            ) : topAllTimeContributors.length > 0 ? (
              topAllTimeContributors.map((contributor) => (
                <Group key={contributor.userId} spacing="md" position="apart">
                  <Group spacing={8}>
                    <UserAvatar
                      userId={contributor.userId}
                      user={contributor.user}
                      indicatorProps={{ color: contributor.team.toLowerCase() }}
                      avatarSize="md"
                      withUsername
                      linkToProfile
                    />
                  </Group>
                  <Group spacing={4}>
                    <CurrencyIcon currency={Currency.BUZZ} />
                    <Text size="xl" weight={500} color="dimmed">
                      {abbreviateNumber(contributor.amount ?? 0)}
                    </Text>
                  </Group>
                </Group>
              ))
            ) : (
              <Paper p="xl">
                <Center>
                  <Text color="dimmed">No donors yet</Text>
                </Center>
              </Paper>
            )}
            <Group position="right">
              <Link href={`/leaderboard/${event}:all-time`}>
                <Button variant="subtle" size="xs" rightIcon={<IconArrowRight size={16} />}>
                  View All
                </Button>
              </Link>
            </Group>
          </Stack>
        </Card>
      </Grid.Col>
      {!ended && (
        <Grid.Col xs={12} sm="auto">
          <Card p={32} radius="lg" h="100%" className={classes.card}>
            <Stack spacing="xl">
              <Stack spacing={0}>
                <Text size={32} weight="bold">
                  Top Donors Today
                </Text>
                {!ended && (
                  <Text size="xs" color="dimmed">
                    As of {formatDate(startTime, 'h:mma')}. Refreshes in:{' '}
                    <Countdown endTime={resetTime} format="short" />
                  </Text>
                )}
              </Stack>
              {loading ? (
                Array.from({ length: 4 }).map((_, index) => (
                  <Group key={index} spacing={8} noWrap>
                    <Skeleton height={40} circle />
                    <Skeleton height={44} />
                  </Group>
                ))
              ) : topDayContributors.length > 0 ? (
                topDayContributors.map((contributor) => (
                  <Group key={contributor.userId} spacing="md" position="apart">
                    <UserAvatar
                      userId={contributor.userId}
                      user={contributor.user}
                      indicatorProps={{ color: contributor.team.toLowerCase() }}
                      avatarSize="md"
                      withUsername
                      linkToProfile
                    />
                    <Group spacing={4}>
                      <CurrencyIcon currency={Currency.BUZZ} />
                      <Text size="xl" weight={500} color="dimmed">
                        {abbreviateNumber(contributor.amount ?? 0)}
                      </Text>
                    </Group>
                  </Group>
                ))
              ) : (
                <Paper p="xl">
                  <Center>
                    <Text color="dimmed">No donors yet</Text>
                  </Center>
                </Paper>
              )}
              <Group position="right">
                <Link href={`/leaderboard/${event}:day`}>
                  <Button variant="subtle" size="xs" rightIcon={<IconArrowRight size={16} />}>
                    View All
                  </Button>
                </Link>
              </Group>
            </Stack>
          </Card>
        </Grid.Col>
      )}
      <Grid.Col span={12}>
        <Card p={32} radius="lg" className={classes.card}>
          <Grid gutter="xl">
            <Grid.Col span={12}>
              <Stack spacing={0}>
                <Text size={32} weight="bold">
                  Top Donors by Team
                </Text>
                <Text size="xs" color="dimmed">
                  As of {formatDate(startTime, 'h:mma')}. Refreshes in:{' '}
                  <Countdown endTime={resetTime} format="short" />
                </Text>
              </Stack>
            </Grid.Col>
            {loading ? (
              <Grid.Col span={12}>
                <Center>
                  <Loader variant="bars" />
                </Center>
              </Grid.Col>
            ) : (
              topTeamContributors.map(([team, contributors]) => (
                <Grid.Col key={team} xs={12} sm="auto">
                  <Stack spacing="xl" h="100%">
                    <Text size={24} weight="bold">
                      {team} Team
                    </Text>

                    {contributors.length > 0 ? (
                      <Stack spacing="sm">
                        {contributors.map((contributor) => (
                          <UserAvatar
                            key={contributor.userId}
                            user={contributor.user}
                            avatarSize="md"
                            withUsername
                            linkToProfile
                          />
                        ))}
                      </Stack>
                    ) : (
                      <Paper py="md">
                        <Center>
                          <Text color="dimmed">No donors yet</Text>
                        </Center>
                      </Paper>
                    )}

                    <Group position="right" mt="auto">
                      <Link href={`/leaderboard/${event}:${team.toLowerCase()}`}>
                        <Button variant="subtle" size="xs" rightIcon={<IconArrowRight size={16} />}>
                          View All
                        </Button>
                      </Link>
                    </Group>
                  </Stack>
                </Grid.Col>
              ))
            )}
          </Grid>
        </Card>
      </Grid.Col>
    </Grid>
  );
}

const useStyles = createStyles((theme) => ({
  card: {
    background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
  },
}));
