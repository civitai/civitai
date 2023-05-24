import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { stringDate } from '~/utils/zod-helpers';
import { z } from 'zod';
import { useRouter } from 'next/router';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  ActionIcon,
  Code,
  Container,
  createStyles,
  Grid,
  Group,
  Popover,
  Stack,
  Text,
  Title,
  Loader,
  Center,
  Box,
  NavLink,
  ScrollArea,
  Badge,
  Drawer,
  MantineSize,
} from '@mantine/core';
import { useMemo, useState } from 'react';
import { IconInfoCircle, IconLayoutSidebarLeftExpand } from '@tabler/icons-react';
import { useDisclosure } from '@mantine/hooks';
import { Countdown } from '~/components/Countdown/Countdown';
import dayjs from 'dayjs';
import { CreatorList } from '~/components/Leaderboard/CreatorList';
import { IsClient } from '~/components/IsClient/IsClient';
import { Meta } from '~/components/Meta/Meta';

const leaderboardQuerySchema = z.object({
  id: z.string().default('overall'),
  date: stringDate(),
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
  const { id, date } = leaderboardQuerySchema.parse(query);
  const currentUser = useCurrentUser();
  const { classes } = useStyles();

  const [drawerOpen, { close, toggle }] = useDisclosure();

  const { data: leaderboards = [] } = trpc.leaderboard.getLeaderboards.useQuery(undefined, {
    onSuccess: (data) => {
      if (selectedLeaderboard?.id !== id) setSelectedLeaderboard(data.find((x) => x.id === id));
    },
  });
  const { data: leaderboardResults = [], isLoading: loadingLeaderboardResults } =
    trpc.leaderboard.getLeaderboard.useQuery({ id, date });
  const { data: leaderboardPositionsRaw = [], isLoading: loadingLeaderboardPositions } =
    trpc.leaderboard.getLeaderboardPositions.useQuery(
      { date, userId: currentUser?.id },
      {
        enabled: !!currentUser,
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

  if (selectedLeaderboard && selectedLeaderboard.id !== id) {
    replace(`/leaderboard/${selectedLeaderboard.id}`, undefined, { shallow: true });
  }

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
            />
          </Group>
        }
        onClick={() => {
          setSelectedLeaderboard(item);
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
      />
      <Container size="lg">
        <Grid gutter="xl">
          <Grid.Col xs={12} sm={4} className={classes.sidebar}>
            <Box maw={300} w="100%">
              {navLinks()}
            </Box>
          </Grid.Col>

          <Grid.Col xs={12} sm={8} display="flex" sx={{ justifyContent: 'center' }}>
            <Stack spacing={0} maw={600} w="100%">
              <Group spacing={8} position="apart" noWrap>
                <Title className={classes.title}>{selectedLeaderboard?.title}</Title>
                <ActionIcon
                  className={classes.drawerButton}
                  size="md"
                  variant="transparent"
                  onClick={toggle}
                >
                  <IconLayoutSidebarLeftExpand />
                </ActionIcon>
              </Group>
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
                    <Stack spacing={4}>
                      <Text weight={500}>Rank is calculated based on:</Text>
                      <Code block color="blue">
                        {selectedLeaderboard?.scoringDescription}
                      </Code>
                      <Text color="dimmed" size="xs">
                        Only the last 30 days are considered
                      </Text>
                    </Stack>
                  </Popover.Dropdown>
                </Popover>
              </Group>
              <Text color="dimmed" size="xs" mb="lg">
                As of{' '}
                {leaderboardResults[0]
                  ? dayjs(leaderboardResults[0].date).format('MMMM D, YYYY h:mma')
                  : 'loading..'}
                . Refreshes in:{' '}
                <Text span>
                  <Countdown endTime={dayjs().utc().endOf('day').toDate()} />
                </Text>
              </Text>
              {loadingLeaderboardResults ? (
                <Center p="xl">
                  <Loader size="xl" />
                </Center>
              ) : leaderboardResults.length > 0 ? (
                <CreatorList data={leaderboardResults} />
              ) : null}
            </Stack>
          </Grid.Col>
        </Grid>
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
        <ScrollArea.Autosize maxHeight={'calc(100vh - 48px)'}>{navLinks('md')}</ScrollArea.Autosize>
      </Drawer>
    </>
  );
}

const UserPosition = ({ position, loading }: { position?: number; loading?: boolean }) => {
  const currentUser = useCurrentUser();

  if (!currentUser) return null;
  if (loading)
    return (
      <Badge color="gray">
        <Loader variant="dots" size="xs" color="gray" />
      </Badge>
    );
  if (!position) return null;

  return (
    <Badge color={position <= 10 ? 'yellow' : position <= 100 ? 'gray' : 'blue'} variant="outline">
      #{position}
    </Badge>
  );
};

const useStyles = createStyles((theme) => ({
  title: {
    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      fontSize: 28,
    },
  },
  slogan: {
    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
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
    [theme.fn.smallerThan('sm')]: {
      display: 'none',
    },
  },

  drawerButton: {
    display: 'none',
    [theme.fn.smallerThan('sm')]: {
      display: 'block',
    },
  },

  drawerHeader: {
    padding: theme.spacing.xs,
    marginBottom: 0,
    boxShadow: theme.shadows.sm,
  },
}));
