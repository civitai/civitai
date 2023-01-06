import { Group, Stack, Container, Title, Alert, Text, createStyles } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { capitalize } from 'lodash';
import { GetServerSideProps } from 'next';
import { useSession } from 'next-auth/react';
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
  const { classes } = useStyles();
  const [welcomeAlert, setWelcomeAlert] = useLocalStorage({
    key: 'welcomeAlert',
    defaultValue: true,
  });

  const closeWelcomeAlert = () => {
    setWelcomeAlert(false);
  };

  return (
    <>
      <Meta
        title={`Civitai ${
          !session ? `| Stable Diffusion models, embeddings, hypernetworks and more` : ''
        }`}
        description={`Civitai is a platform for Stable Diffusion AI Art models. We have a collection of over 1,700 models from 250+ creators. We also have a collection of 1200 reviews from the community along with 12,000+ images with prompts to get you started.`}
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
          {welcomeAlert && (
            <Alert
              color="blue"
              withCloseButton
              py={5}
              pl={3}
              className={classes.welcome}
              onClose={closeWelcomeAlert}
            >
              <Group spacing="xs" noWrap>
                <Text size={36} p={0}>
                  👋
                </Text>
                <Stack spacing={0}>
                  <Text size="md" weight={500} className={classes.welcomeTitle} mb={4}>
                    Welcome to Civitai!
                  </Text>
                  <Text size="sm" className={classes.welcomeText}>
                    Browse, share, and review custom AI art models,{' '}
                    <Text component="a" variant="link" href="/content/guides/what-is-civitai">
                      learn more...
                    </Text>
                  </Text>
                </Stack>
              </Group>
            </Alert>
          )}
          <Group position="apart" spacing={0}>
            <InfiniteModelsSort />
            <Group spacing={4}>
              <InfiniteModelsPeriod />
              <InfiniteModelsFilter />
            </Group>
          </Group>
          <InfiniteModels delayNsfw />
        </Stack>
      </Container>
    </>
  );
}

// Home.getLayout = (page: React.ReactElement) => <>{page}</>;
export default Home;

const useStyles = createStyles((theme) => ({
  welcome: {
    maxWidth: 600,
    top: 75,
    marginBottom: -40,
    position: 'sticky',
    alignSelf: 'center',
    zIndex: 11,
    boxShadow: theme.shadows.md,
    border: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors.blue[9] : theme.colors.blue[2]
    }`,
    backgroundColor:
      theme.colorScheme === 'dark'
        ? theme.fn.darken(theme.colors.blue[8], 0.5)
        : theme.colors.blue[1],
    [theme.fn.smallerThan('md')]: {
      marginBottom: 5,
      marginLeft: -5,
      marginRight: -5,
    },
  },
  welcomeTitle: {
    color: theme.colorScheme === 'dark' ? theme.colors.blue[0] : theme.colors.blue[7],
    lineHeight: 1.1,
  },
  welcomeText: {
    color: theme.colorScheme === 'dark' ? theme.colors.blue[2] : undefined,
    lineHeight: 1.1,
  },
}));
