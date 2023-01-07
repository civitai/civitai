import {
  ActionIcon,
  Code,
  Container,
  Grid,
  Group,
  Popover,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons';
import { GetServerSideProps } from 'next';

import { CreatorList } from '~/components/Leaderboard/CreatorList';
import { Meta } from '~/components/Meta/Meta';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const ssg = await getServerProxySSGHelpers(ctx);
  await ssg.user.getLeaderboard.prefetch({ limit: 100 });

  return {
    props: {
      trpcState: ssg.dehydrate(),
    },
  };
};

export default function Leaderboard() {
  const { data = [] } = trpc.user.getLeaderboard.useQuery({ limit: 100 });

  return (
    <>
      <Meta title="Creators Leaderboard | Civitai" />
      <Container size="xs">
        <Grid gutter="xl">
          <Grid.Col span={12}>
            <Stack spacing={0}>
              <Title order={1}>Creators Leaderboard</Title>
              <Group spacing={5}>
                <Text color="dimmed" size="lg">
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
                        {`(downloads / 100) +\n(averageRating * ratingCount * 10) +\n(favorites * 5)`}
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
          <Grid.Col span={12}>{data.length > 0 ? <CreatorList items={data} /> : null}</Grid.Col>
        </Grid>
      </Container>
    </>
  );
}
