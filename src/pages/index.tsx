import { Group, Stack, Container, Title } from '@mantine/core';
import { capitalize } from 'lodash';
import { GetServerSideProps } from 'next';
import { useSession } from 'next-auth/react';
import Head from 'next/head';
import { useRouter } from 'next/router';

import { InfiniteModels } from '~/components/InfiniteModels/InfiniteModels';
import {
  InfiniteModelsFilter,
  InfiniteModelsPeriod,
  InfiniteModelsSort,
} from '~/components/InfiniteModels/InfiniteModelsFilters';
import { Meta } from '~/components/Meta/Meta';
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
  const { data: session } = useSession();

  return (
    <>
      <Meta
        title={`Civitai ${!session ? `| Every model in one place` : ''}`}
        description={`Civitai is a platform for Stable Diffusion AI Art models. We have a collection of over 1000 models from over 50 creators. We also have a collection of over 145 reviews from the community along with 100+ images with prompts to get you started.`}
      />
      <Container size="xl">
        {router.query.username && typeof router.query.username === 'string' && (
          <Title>Models by {router.query.username}</Title>
        )}
        {router.query.favorites && <Title>Your Liked Models</Title>}
        {router.query.tag && typeof router.query.tag === 'string' && (
          <Title>{capitalize(router.query.tag)} Models</Title>
        )}
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

// Home.getLayout = (page: React.ReactElement) => <>{page}</>;
export default Home;
