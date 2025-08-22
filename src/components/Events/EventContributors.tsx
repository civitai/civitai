import {
  Button,
  Card,
  Center,
  Grid,
  Group,
  Loader,
  Paper,
  Skeleton,
  Stack,
  Text,
} from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { abbreviateNumber } from '~/utils/number-helpers';
import { useQueryEventContributors } from './events.utils';
import { CurrencyIcon } from '../Currency/CurrencyIcon';
import { Currency } from '~/shared/utils/prisma/enums';
import { UserAvatar } from '../UserAvatar/UserAvatar';
import dayjs from '~/shared/utils/dayjs';
import { formatDate } from '~/utils/date-helpers';
import { Countdown } from '~/components/Countdown/Countdown';

const resetTime = dayjs().endOf('hour').toDate();
const startTime = dayjs().startOf('hour').toDate();

export function EventContributors({ event, endDate }: { event: string; endDate: Date }) {
  const { contributors, loading } = useQueryEventContributors({ event });

  const topDayContributors = contributors?.day.slice(0, 4) ?? [];
  const topAllTimeContributors = contributors?.allTime.slice(0, 4) ?? [];
  const topTeamContributors = Object.entries(contributors?.teams ?? {}).map(
    ([team, users]) => [team, users.slice(0, 4)] as const
  );

  const ended = resetTime > endDate;

  return (
    <Grid gutter={48}>
      <Grid.Col span={{ base: 12, sm: 'auto' }}>
        <Card radius="lg" h="100%" className="bg-gray-0 p-4 md:p-8 dark:bg-dark-6">
          <Stack gap="xl">
            <Stack gap={0}>
              <Text fz={32} fw="bold">
                Top Donors All Time
              </Text>
              {!ended && (
                <Text size="xs" c="dimmed">
                  As of {formatDate(startTime, 'h:mma')}. Refreshes in:{' '}
                  <Countdown endTime={resetTime} format="short" />
                </Text>
              )}
            </Stack>
            {loading ? (
              Array.from({ length: 4 }).map((_, index) => (
                <Group key={index} gap={8} wrap="nowrap">
                  <Skeleton height={40} circle />
                  <Skeleton height={44} />
                </Group>
              ))
            ) : topAllTimeContributors.length > 0 ? (
              topAllTimeContributors.map((contributor) => (
                <Group key={contributor.userId} gap="md" justify="space-between">
                  <Group gap={8}>
                    <UserAvatar
                      userId={contributor.userId}
                      user={contributor.user}
                      indicatorProps={{ color: contributor.team.toLowerCase() }}
                      avatarSize="md"
                      withUsername
                      linkToProfile
                    />
                  </Group>
                  <Group gap={4}>
                    <CurrencyIcon currency={Currency.BUZZ} />
                    <Text size="xl" fw={500} c="dimmed">
                      {abbreviateNumber(contributor.amount ?? 0)}
                    </Text>
                  </Group>
                </Group>
              ))
            ) : (
              <Paper p="xl">
                <Center>
                  <Text c="dimmed">No donors yet</Text>
                </Center>
              </Paper>
            )}
            <Group justify="flex-end">
              <Link href={`/leaderboard/${event}:all-time`}>
                <Button variant="subtle" size="xs" rightSection={<IconArrowRight size={16} />}>
                  View All
                </Button>
              </Link>
            </Group>
          </Stack>
        </Card>
      </Grid.Col>
      {!ended && (
        <Grid.Col span={{ base: 12, sm: 'auto' }}>
          <Card p={32} radius="lg" h="100%" className="bg-gray-0 dark:bg-dark-6">
            <Stack gap="xl">
              <Stack gap={0}>
                <Text fz={32} fw="bold">
                  Top Donors Today
                </Text>
                {!ended && (
                  <Text size="xs" c="dimmed">
                    As of {formatDate(startTime, 'h:mma')}. Refreshes in:{' '}
                    <Countdown endTime={resetTime} format="short" />
                  </Text>
                )}
              </Stack>
              {loading ? (
                Array.from({ length: 4 }).map((_, index) => (
                  <Group key={index} gap={8} wrap="nowrap">
                    <Skeleton height={40} circle />
                    <Skeleton height={44} />
                  </Group>
                ))
              ) : topDayContributors.length > 0 ? (
                topDayContributors.map((contributor) => (
                  <Group key={contributor.userId} gap="md" justify="space-between">
                    <UserAvatar
                      userId={contributor.userId}
                      user={contributor.user}
                      indicatorProps={{ color: contributor.team.toLowerCase() }}
                      avatarSize="md"
                      withUsername
                      linkToProfile
                    />
                    <Group gap={4}>
                      <CurrencyIcon currency={Currency.BUZZ} />
                      <Text size="xl" fw={500} c="dimmed">
                        {abbreviateNumber(contributor.amount ?? 0)}
                      </Text>
                    </Group>
                  </Group>
                ))
              ) : (
                <Paper p="xl">
                  <Center>
                    <Text c="dimmed">No donors yet</Text>
                  </Center>
                </Paper>
              )}
              <Group justify="flex-end">
                <Link href={`/leaderboard/${event}:day`}>
                  <Button variant="subtle" size="xs" rightSection={<IconArrowRight size={16} />}>
                    View All
                  </Button>
                </Link>
              </Group>
            </Stack>
          </Card>
        </Grid.Col>
      )}
      <Grid.Col span={12}>
        <Card p={32} radius="lg" className="bg-gray-0 dark:bg-dark-6">
          <Grid gutter="xl">
            <Grid.Col span={12}>
              <Stack gap={0}>
                <Text fz={32} fw="bold">
                  Top Donors by Team
                </Text>
                <Text size="xs" c="dimmed">
                  As of {formatDate(startTime, 'h:mma')}. Refreshes in:{' '}
                  <Countdown endTime={resetTime} format="short" />
                </Text>
              </Stack>
            </Grid.Col>
            {loading ? (
              <Grid.Col span={12}>
                <Center>
                  <Loader type="bars" />
                </Center>
              </Grid.Col>
            ) : (
              topTeamContributors.map(([team, contributors]) => (
                <Grid.Col key={team} span={{ base: 12, sm: 'auto' }}>
                  <Stack gap="xl" className="h-full">
                    <Text fz={24} fw="bold">
                      {team} Team
                    </Text>

                    {contributors.length > 0 ? (
                      <Stack gap="sm">
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
                          <Text c="dimmed">No donors yet</Text>
                        </Center>
                      </Paper>
                    )}

                    <Group justify="flex-end" mt="auto">
                      <Link href={`/leaderboard/${event}:${team.toLowerCase()}`}>
                        <Button
                          variant="subtle"
                          size="xs"
                          rightSection={<IconArrowRight size={16} />}
                        >
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
