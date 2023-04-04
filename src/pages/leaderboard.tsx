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
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons';

import { CreatorList } from '~/components/Leaderboard/CreatorList';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    await ssg?.user.getLeaderboard.prefetch({ limit: 100 });
  },
});

export default function Leaderboard() {
  const { data = [], isLoading } = trpc.user.getLeaderboard.useQuery({ limit: 100 });
  const { classes } = useStyles();

  return (
    <>
      <Meta
        title="Creators Leaderboard | Agentswap"
        description={`The top creators of Stable Diffusion models this month are ${data
          .slice(0, 10)
          .map((x, i) => `${i + 1}. ${x.username}`)
          .join(', ')}... Check out the full leaderboard.`}
      />
      <Container size="xs">
        <Grid gutter="xl">
          <Grid.Col span={12}>
            <Stack spacing={0}>
              <Title className={classes.title} order={1}>
                Creators Leaderboard
              </Title>
              <Group spacing={5}>
                <Text className={classes.slogan} color="dimmed" size="lg">
                  Climb to the top by engaging the community
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
                        {`(downloads / 100) +\n(averageRating * ratingCount * 10) +\n(favorites * 5) +\n(answers * 3) +\n(answerAccepts * 5)`}
                      </Code>
                      <Text color="dimmed" size="xs">
                        Only the last 30 days are considered
                      </Text>
                    </Stack>
                  </Popover.Dropdown>
                </Popover>
              </Group>
            </Stack>
          </Grid.Col>
          <Grid.Col span={12}>
            {isLoading ? (
              <Center p="xl">
                <Loader size="xl" />
              </Center>
            ) : data.length > 0 ? (
              <CreatorList items={data} />
            ) : null}
          </Grid.Col>
        </Grid>
      </Container>
    </>
  );
}

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
}));
