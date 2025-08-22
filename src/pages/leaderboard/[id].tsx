import type { MantineSize, SegmentedControlProps } from '@mantine/core';
import {
  Alert,
  Badge,
  Box,
  Center,
  Code,
  Container,
  Drawer,
  Group,
  Loader,
  NavLink,
  Popover,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconInfoCircle, IconLayoutSidebarLeftExpand } from '@tabler/icons-react';
import clsx from 'clsx';
import dayjs from '~/shared/utils/dayjs';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import * as z from 'zod';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';

import { Countdown } from '~/components/Countdown/Countdown';
import { CreatorList } from '~/components/Leaderboard/CreatorList';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { Meta } from '~/components/Meta/Meta';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { numericString } from '~/utils/zod-helpers';
import classes from './[id].module.css';

const excludeLegendsRegex = /Donors|Knights/i;

const leaderboardQuerySchema = z.object({
  id: z.string().default('overall'),
  date: z.coerce.date().optional(),
  position: numericString().optional(),
  board: z.enum(['season', 'legend']).default('season'),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    await ssg?.leaderboard.getLeaderboards.prefetch();
  },
});

export default function Leaderboard() {
  const { query, replace } = useRouter();
  const { id, date, position, board } = leaderboardQuerySchema.parse(query);
  const currentUser = useCurrentUser();
  const isDisabled = id === 'images-rater';
  // const isDisabled = false;

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
  const hasLegends = !!selectedLeaderboard && !excludeLegendsRegex.test(selectedLeaderboard.title);
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
          <Group justify="space-between">
            <Text fw={500}>{item.title}</Text>
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
        <ContainerGrid2 gutter="xl">
          <ContainerGrid2.Col span={{ base: 12, sm: 4 }} className={classes.sidebar}>
            <Box maw={300} w="100%">
              {navLinks()}
            </Box>
          </ContainerGrid2.Col>

          <ContainerGrid2.Col
            span={{ base: 12, sm: 8 }}
            display="flex"
            style={{ justifyContent: 'center' }}
          >
            <Stack gap={0} maw={600} w="100%">
              <Group gap={8} wrap="nowrap">
                <Title className={classes.title}>{selectedLeaderboard?.title}</Title>
                {hasLegends && <LegendsToggle className={classes.legendsToggleSm} />}
                <LegacyActionIcon
                  className={classes.drawerButton}
                  size="md"
                  variant="transparent"
                  onClick={toggle}
                >
                  <IconLayoutSidebarLeftExpand />
                </LegacyActionIcon>
              </Group>
              {hasLegends && <LegendsToggle className={classes.legendsToggle} />}
              <Group gap={5}>
                <Text className={classes.slogan} c="dimmed" size="lg">
                  {selectedLeaderboard?.description}
                </Text>
                <Popover withArrow>
                  <Popover.Target>
                    <LegacyActionIcon variant="transparent" size="sm">
                      <IconInfoCircle />
                    </LegacyActionIcon>
                  </Popover.Target>
                  <Popover.Dropdown>
                    {board === 'season' ? (
                      <Stack gap={4}>
                        <Text fw={500}>Rank is calculated based on:</Text>
                        <Code block>{selectedLeaderboard?.scoringDescription}</Code>
                        <Text c="dimmed" size="xs">
                          Only the last 30 days are considered
                        </Text>
                      </Stack>
                    ) : board === 'legend' ? (
                      <Stack gap={4}>
                        <Text fw={500}>Score is calculated based on:</Text>
                        <Code block>
                          {`Diamond - 1st place: ${
                            constants.leaderboard.legendScoring.diamond * 100
                          } points per day
Gold - Top 3: ${constants.leaderboard.legendScoring.gold * 100} points per day
Silver - Top 10: ${constants.leaderboard.legendScoring.silver * 100} points per day
Bronze - Top 100: ${constants.leaderboard.legendScoring.bronze * 100} points per day`}
                        </Code>
                        <Text c="dimmed" size="xs">
                          The entire history of the leaderboard is considered
                        </Text>
                      </Stack>
                    ) : null}
                  </Popover.Dropdown>
                </Popover>
              </Group>
              {isDisabled ? (
                <Alert color="yellow" my="sm" py={6} px={12}>
                  <Text lh={1.3} size="sm">
                    This leaderboard is having some issues and is temporarily disabled. It will be
                    back soon.
                  </Text>
                </Alert>
              ) : (
                <Text c="dimmed" size="xs" mb="lg">
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
          </ContainerGrid2.Col>
        </ContainerGrid2>
      </Container>
      <Drawer
        opened={drawerOpen}
        onClose={close}
        size="100%"
        title={
          <Text size="lg" fw={500}>
            Leaderboards
          </Text>
        }
        classNames={{ header: classes.drawerHeader }}
      >
        <ScrollArea>{navLinks('md')}</ScrollArea>
      </Drawer>
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
      onChange={(board) => setBoard(board as 'season' | 'legend')}
      color="blue"
      ml="auto"
      orientation="horizontal"
      className="border border-gray-4 bg-none dark:border-dark-4"
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
        <Loader type="dots" size="xs" color="gray" />
      </Badge>
    );
  if (!position) return null;

  const top10 = position <= 10;
  const top100 = position <= 100;

  return (
    <Badge
      color={top10 ? 'yellow' : top100 ? 'blue' : 'gray'}
      className={clsx(classes.userPosition, top10 && classes.top10, top100 && classes.top100)}
      variant="outline"
      onClick={(event: React.MouseEvent<HTMLDivElement>) => {
        event.stopPropagation();
        event.preventDefault();

        onClick(position);
      }}
    >
      #{position}
    </Badge>
  );
};
