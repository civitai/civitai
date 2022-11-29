import { Group, Stack, Container, Title } from '@mantine/core';
import { GetServerSideProps } from 'next';
import Head from 'next/head';
import { useRouter } from 'next/router';

import { InfiniteModels } from '~/components/InfiniteModels/InfiniteModels';
import { ListFilter } from '~/components/ListFilter/ListFilter';
import { ListPeriod } from '~/components/ListPeriod/ListPeriod';
import { ListSort } from '~/components/ListSort/ListSort';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerAuthSession(context);
  const ssg = await getServerProxySSGHelpers(context);
  if (session) await ssg.user.getFavoriteModels.prefetch(undefined);

  return {
    props: {
      trpcState: ssg.dehydrate(),
    },
  };
};

function Home() {
  const router = useRouter();

  return (
    <>
      <Head>
        <meta name="description" content="Community driven AI model sharing tool" />
      </Head>
      <Container size="xl" p={0}>
        {router.query.username && <Title>Models by {router.query.username}</Title>}
        <Stack spacing="xs">
          <Group position="apart">
            <ListSort />
            <Group spacing="xs">
              <ListPeriod />
              <ListFilter />
            </Group>
          </Group>
          <InfiniteModels />
        </Stack>
      </Container>
    </>
  );
}

// Home.getLayout = (page: React.ReactElement) => <>{page}</>;
export default Home;
