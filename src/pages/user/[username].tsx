import { Container, Title, Stack, Group } from '@mantine/core';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next/types';
import { InfiniteModels } from '~/components/InfiniteModels/InfiniteModels';
import {
  InfiniteModelsSort,
  InfiniteModelsPeriod,
  InfiniteModelsFilter,
} from '~/components/InfiniteModels/InfiniteModelsFilters';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const ssg = await getServerProxySSGHelpers(ctx);
  const username = ctx.query.username as string;
  if (username) await ssg.user.getStats.prefetch({ username });

  return {
    props: {
      trpcState: ssg.dehydrate(),
    },
  };
};

export default function UserPage() {
  const router = useRouter();
  const username = router.query.username as string;

  const { data, isLoading } = trpc.user.getStats.useQuery({ username }, { enabled: !!username });

  return (
    <>
      <Head>
        <meta name="description" content="Community driven AI model sharing tool" />
      </Head>
      <Container size="xl" p={0}>
        {router.query.username && <Title>Models by {router.query.username}</Title>}
        <Stack spacing="xs">
          <Group position="apart">
            <InfiniteModelsSort />
            <Group spacing="xs">
              <InfiniteModelsPeriod />
              <InfiniteModelsFilter />
            </Group>
          </Group>
          <InfiniteModels />
        </Stack>
      </Container>
    </>
  );
}
