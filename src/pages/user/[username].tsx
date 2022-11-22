import { Container, Title, Stack, Group } from '@mantine/core';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next/types';
import { InfiniteModels } from '~/components/InfiniteModels/InfiniteModels';
import { ListFilter } from '~/components/ListFilter/ListFilter';
import { ListPeriod } from '~/components/ListPeriod/ListPeriod';
import { ListSort } from '~/components/ListSort/ListSort';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const ssg = await getServerProxySSGHelpers(ctx);
  const username = ctx.query.username;
  // if (isNumber(id)) await ssg.model.getById.prefetch({ id });

  return {
    props: {
      trpcState: ssg.dehydrate(),
    },
  };
};

export default function UserPage() {
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
