import {
  ActionIcon,
  Badge,
  Box,
  Center,
  Code,
  Container,
  Drawer,
  Group,
  Loader,
  MantineSize,
  NavLink,
  Popover,
  Stack,
  Text,
  Title,
  createStyles,
  SegmentedControl,
  SegmentedControlProps,
  Alert,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconInfoCircle, IconLayoutSidebarLeftExpand } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { z } from 'zod';

import { Countdown } from '~/components/Countdown/Countdown';
import { ScrollToTopFab } from '~/components/FloatingActionButton/ScrollToTopFab';
import { CreatorList } from '~/components/Leaderboard/CreatorList';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { numericString, stringDate } from '~/utils/zod-helpers';
import { env } from '~/env/client.mjs';
import { removeEmpty } from '~/utils/object-helpers';
import { constants } from '~/server/common/constants';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';

const leaderboardQuerySchema = z.object({
  id: z.string().default('overall'),
  date: stringDate(),
  position: numericString().optional(),
  board: z.enum(['season', 'legend']).default('season'),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg, ctx }) => {
    const { id, date } = leaderboardQuerySchema.parse(ctx.query);
    await ssg?.leaderboard.getLeaderboards.prefetch();
  },
});

export default function Leaderboard() {
  const { query, replace } = useRouter();
  const { id, date, position, board } = leaderboardQuerySchema.parse(query);
  const currentUser = useCurrentUser();
  const { classes } = useStyles();
  // const isDisabled = id === 'images-nsfw';
  const isDisabled = false;

  const [drawerOpen, { close, toggle }] = useDisclosure();

  const { data: leaderboards = [] } = trpc.leaderboard.getLeaderboards.useQuery(undefined, {
    trpc: { context: { skipBatch: true } },
    onSuccess: (data) => {
      if (selectedLeaderboard?.id !== id) setSelectedLeaderboard(data.find((x) => x.id === id));
    },
  });
  const { data: leaderboardSeason = [], isLoading: loadingLeaderboardSeason } =
    trpc.leaderboard.getLeaderboard.useQuery(
      { id, date },
      {
        enabled: board === 'season' && !isDisabled,
        trpc: { context: { skipBatch: true } },
      }
    );
  const { data: leaderboardLegend = [], isLoading: loadingLeaderboardLegend } =
    trpc.leaderboard.getLeadboardLegends.useQuery(
      { id, date },
      {
        enabled: board === 'legend',
        trpc: { context: { skipBatch: true } },
      }
    );
  const { data: leaderboardPositionsRaw = [], isLoading: loadingLeaderboardPositions } =
    trpc.leaderboard.getLeaderboardPositions.useQuery(
      { date, userId: currentUser?.id, top: 1000 },
      {
        enabled: !!currentUser,
        trpc: { context: { skipBatch: true } },
      }
    );
  const leaderboardPositions = useMemo(() => {
    return leaderboardPositionsRaw.reduce((acc, item) => {
      acc[item.leaderboardId] = item.position;
      return acc;
    }, {} as Record<string, number>);
  }, [leaderboardPositionsRaw]);

  const [selectedLeaderboard, setSelectedLeaderboard] = useState(
    leaderboards.find((x) => x.id === id)
  );
  const hasLegends = !selectedLeaderboard?.title.includes('Donors');
  const [selectedPosition, setSelectedPosition] = useState<number | null>(null);
  const leaderboardResults = board === 'season' ? leaderboardSeason : leaderboardLegend;
  const loadingLeaderboardResults =
    board === 'season' ? loadingLeaderboardSeason : loadingLeaderboardLegend;

  if (
    (selectedLeaderboard && selectedLeaderboard.id !== id) ||
    (selectedPosition && selectedPosition !== position) ||
    (!hasLegends && board === 'legend')
  ) {
    const shallow = selectedLeaderboard?.id === id && selectedPosition !== position;

    replace(
      {
        pathname: `/leaderboard/${selectedLeaderboard?.id}`,
        query: removeEmpty({
          position: selectedPosition ? String(selectedPosition) : undefined,
          board: board === 'season' || (!hasLegends && board === 'legend') ? undefined : board,
        }),
      },
      undefined,
      { shallow }
    );
  }

  const endTime = useMemo(() => dayjs().utc().endOf('day').toDate(), []);

  const navLinks = (itemSize?: MantineSize) =>
    leaderboards.map((item) => (
      <NavLink
        key={item.id}
        p={itemSize}
        label={
          <Group position="apart">
            <Text weight={500}>{item.title}</Text>
            <UserPosition
              position={leaderboardPositions[item.id]}
              loading={loadingLeaderboardPositions}
              onClick={(position) => {
                setSelectedPosition(position);
                setSelectedLeaderboard(item);
                close();
              }}
            />
          </Group>
        }
        onClick={() => {
          setSelectedLeaderboard(item);
          setSelectedPosition(null);
          close();
        }}
        className={classes.navItem}
        active={selectedLeaderboard?.id === item.id}
      />
    ));

  return (
    <>
      <Meta
        title={`${selectedLeaderboard?.title ?? ''} Leaderboard | Civitai`}
        description={`${selectedLeaderboard?.description} this month are ${leaderboardResults
          .slice(0, 10)
          .map((x, i) => `${i + 1}. ${x.user.username}`)
          .join(', ')}... Check out the full leaderboard.`}
        links={[
          {
            href: `${env.NEXT_PUBLIC_BASE_URL}/leaderboard/${selectedLeaderboard?.id ?? 'overall'}`,
            rel: 'canonical',
          },
        ]}
      />
      <Container size="lg">
        <ContainerGrid gutter="xl">
          <ContainerGrid.Col xs={12} sm={4} className={classes.sidebar}>
            <Box maw={300} w="100%">
              {navLinks()}
            </Box>
          </ContainerGrid.Col>

          <ContainerGrid.Col xs={12} sm={8} display="flex" sx={{ justifyContent: 'center' }}>
            <Stack spacing={0} maw={600} w="100%">
              <Group spacing={8} noWrap>
                <Title className={classes.title}>{selectedLeaderboard?.title}</Title>
                {hasLegends && <LegendsToggle className={classes.legendsToggleSm} />}
                <ActionIcon
                  className={classes.drawerButton}
                  size="md"
                  variant="transparent"
                  onClick={toggle}
                >
                  <IconLayoutSidebarLeftExpand />
                </ActionIcon>
              </Group>
              {hasLegends && <LegendsToggle className={classes.legendsToggle} />}
              <Group spacing={5}>
                <Text className={classes.slogan} color="dimmed" size="lg">
                  {selectedLeaderboard?.description}
                </Text>
                <Popover withArrow>
                  <Popover.Target>
                    <ActionIcon variant="transparent" size="sm">
                      <IconInfoCircle />
                    </ActionIcon>
                  </Popover.Target>
                  <Popover.Dropdown>
                    {board === 'season' ? (
                      <Stack spacing={4}>
                        <Text weight={500}>Rank is calculated based on:</Text>
                        <Code block color="blue">
                          {selectedLeaderboard?.scoringDescription}
                        </Code>
                        <Text color="dimmed" size="xs">
                          Only the last 30 days are considered
                        </Text>
                      </Stack>
                    ) : board === 'legend' ? (
                      <Stack spacing={4}>
                        <Text weight={500}>Score is calculated based on:</Text>
                        <Code block color="blue">
                          {`Diamond - 1st place: ${
                            constants.leaderboard.legendScoring.diamond * 100
                          } points per day
Gold - Top 3: ${constants.leaderboard.legendScoring.gold * 100} points per day
Silver - Top 10: ${constants.leaderboard.legendScoring.silver * 100} points per day
Bronze - Top 100: ${constants.leaderboard.legendScoring.bronze * 100} points per day`}
                        </Code>
                        <Text color="dimmed" size="xs">
                          The entire history of the leaderboard is considered
                        </Text>
                      </Stack>
                    ) : null}
                  </Popover.Dropdown>
                </Popover>
              </Group>
              <Alert color="yellow" my="sm" py={6} px={12}>
                <Text lh={1.3} size="sm">
                  {`We are in the process of rebalancing these leaderboards. There may be significant changes from day-to-day this week. Be sure to click the "i" icon for more information about scoring.`}
                </Text>
              </Alert>
              {isDisabled ? (
                <Alert color="yellow" my="sm" py={6} px={12}>
                  <Text lh={1.3} size="sm">
                    This leaderboard is having some issues and is temporarily disabled. It will be
                    back soon.
                  </Text>
                </Alert>
              ) : (
                <Text color="dimmed" size="xs" mb="lg">
                  As of{' '}
                  {leaderboardResults[0]
                    ? dayjs(leaderboardResults[0].date).format('MMMM D, YYYY h:mma')
                    : 'loading...'}
                  . Refreshes in:{' '}
                  <Text span>
                    <Countdown endTime={endTime} />
                  </Text>
                </Text>
              )}
              {isDisabled ? null : loadingLeaderboardResults ? (
                <Center p="xl">
                  <Loader size="xl" />
                </Center>
              ) : leaderboardResults.length > 0 ? (
                <CreatorList data={leaderboardResults} />
              ) : null}
            </Stack>
          </ContainerGrid.Col>
        </ContainerGrid>
      </Container>
      <Drawer
        opened={drawerOpen}
        onClose={close}
        size="full"
        title={
          <Text size="lg" weight={500}>
            Leaderboards
          </Text>
        }
        classNames={{ header: classes.drawerHeader }}
      >
        <ScrollArea>{navLinks('md')}</ScrollArea>
      </Drawer>
      <ScrollToTopFab transition="slide-up" />
    </>
  );
}

const LegendsToggle = (props: Omit<SegmentedControlProps, 'data' | 'onChange' | 'value'>) => {
  const { query, pathname, replace } = useRouter();
  const { board } = leaderboardQuerySchema.parse(query);
  const setBoard = (board: 'season' | 'legend') => {
    replace(
      {
        pathname,
        query: removeEmpty({
          ...query,
          board: board === 'season' ? undefined : board,
        }),
      },
      undefined,
      { shallow: true }
    );
  };

  return (
    <SegmentedControl
      data={[
        { value: 'season', label: 'Season' },
        { value: 'legend', label: 'Legend' },
      ]}
      size="xs"
      value={board}
      onChange={setBoard}
      color="blue"
      ml="auto"
      orientation="horizontal"
      styles={(theme) => ({
        root: {
          border: `1px solid ${
            theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
          }`,
          background: 'none',
        },
      })}
      {...props}
    />
  );
};

const UserPosition = ({
  position,
  loading,
  onClick,
}: {
  position?: number;
  loading?: boolean;
  onClick: (position: number) => void;
}) => {
  const currentUser = useCurrentUser();

  if (!currentUser) return null;
  if (loading)
    return (
      <Badge color="gray">
        <Loader variant="dots" size="xs" color="gray" />
      </Badge>
    );
  if (!position) return null;

  const top10 = position <= 10;
  const top100 = position <= 100;

  return (
    <Badge
      color={top10 ? 'yellow' : top100 ? 'blue' : 'gray'}
      variant="outline"
      sx={(theme) => ({
        ':hover': {
          transition: 'background-color 300ms ease',
          backgroundColor: top10
            ? theme.fn.rgba(theme.colors.yellow[5], 0.2)
            : top100
            ? theme.fn.rgba(theme.colors.blue[5], 0.2)
            : undefined,
        },
      })}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();

        onClick(position);
      }}
    >
      #{position}
    </Badge>
  );
};

const useStyles = createStyles((theme) => ({
  title: {
    [containerQuery.smallerThan('xs')]: {
      fontSize: 28,
    },
  },
  slogan: {
    [containerQuery.smallerThan('xs')]: {
      fontSize: theme.fontSizes.sm,
    },
  },
  navItem: {
    borderRight: `1px solid ${theme.colors.gray[theme.colorScheme === 'dark' ? 9 : 2]}`,
    '&[data-active="true"]': {
      borderRightColor: theme.colors.blue[theme.colorScheme === 'dark' ? 9 : 2],
    },
  },
  sidebar: {
    display: 'block',
    [containerQuery.smallerThan('sm')]: {
      display: 'none',
    },
  },

  drawerButton: {
    display: 'none',
    [containerQuery.smallerThan('sm')]: {
      marginLeft: 'auto',
      display: 'block',
    },
  },

  drawerHeader: {
    padding: theme.spacing.xs,
    marginBottom: 0,
    boxShadow: theme.shadows.sm,
  },

  legendsToggleSm: {
    [containerQuery.smallerThan('sm')]: {
      display: 'none',
    },
  },

  legendsToggle: {
    width: '100%',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
    [containerQuery.largerThan('sm')]: {
      display: 'none',
    },
  },
}));
