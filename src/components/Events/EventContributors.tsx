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

export function EventContributors({ event }: { event: string }) {
  const { contributors, loading } = useQueryEventContributors({ event });
  const { classes } = useStyles();

  const topDayContributors = contributors?.day.slice(0, 4) ?? [];
  const topAllTimeContributors = contributors?.allTime.slice(0, 4) ?? [];
  const topTeamContributors = Object.entries(contributors?.teams ?? {}).map(
    ([team, users]) => [team, users.slice(0, 4)] as const
  );

  return (
    <Grid gutter={48}>
      <Grid.Col xs={12} sm="auto">
        <Card p={32} radius="lg" h="100%" className={classes.card}>
          <Stack spacing="xl">
            <Text size={32} weight="bold">
              Top contributors all time
            </Text>
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
                  <Text color="dimmed">No contributors yet</Text>
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
      <Grid.Col xs={12} sm="auto">
        <Card p={32} radius="lg" h="100%" className={classes.card}>
          <Stack spacing="xl">
            <Text size={32} weight="bold">
              Top contributors today
            </Text>
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
                  <Text color="dimmed">No contributors yet</Text>
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
      <Grid.Col span={12}>
        <Card p={32} radius="lg" className={classes.card}>
          <Grid gutter="xl">
            <Grid.Col span={12}>
              <Text size={32} weight="bold">
                Top Contributors by Team
              </Text>
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
                  <Stack spacing="xl" h="100%" justify="space-between">
                    <Text size={24} weight="bold">
                      Team {team}
                    </Text>
                    {contributors.length > 0 ? (
                      contributors.map((contributor) => (
                        <UserAvatar
                          key={contributor.userId}
                          user={contributor.user}
                          avatarSize="md"
                          withUsername
                          linkToProfile
                        />
                      ))
                    ) : (
                      <Paper p="xl">
                        <Center>
                          <Text color="dimmed">No contributors yet</Text>
                        </Center>
                      </Paper>
                    )}

                    <Group position="right">
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
