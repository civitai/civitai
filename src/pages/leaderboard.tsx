import { Container, Grid, Stack, Text, Title } from '@mantine/core';
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
              <Text color="dimmed" size="lg">
                Climp up to the top by engaging with the community
              </Text>
            </Stack>
          </Grid.Col>
          <Grid.Col span={12}>{data.length > 0 ? <CreatorList items={data} /> : null}</Grid.Col>
        </Grid>
      </Container>
    </>
  );
}
