import { Alert, createStyles, Container, Group, Stack, Text, Title } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { GetServerSideProps } from 'next';
import { useRouter } from 'next/router';

import { InfiniteModels } from '~/components/InfiniteModels/InfiniteModels';
import {
  InfiniteModelsFilter,
  InfiniteModelsPeriod,
  InfiniteModelsSort,
} from '~/components/InfiniteModels/InfiniteModelsFilters';
import { Meta } from '~/components/Meta/Meta';
import { TrendingTags } from '~/components/TrendingTags/TrendingTags';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerAuthSession(context);
  const ssg = await getServerProxySSGHelpers(context);
  if (session) {
    // Prefetch user's favorite models
    await ssg.user.getEngagedModels.prefetch(undefined);
    // Prefetch users' blocked tags
    await ssg.user.getTags.prefetch({ type: 'Hide' });
  }

  // Prefetch trending tags
  await ssg.tag.getTrending.prefetch({ entityType: 'Model' });

  return {
    props: {
      trpcState: ssg.dehydrate(),
    },
  };
};

function Home() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const { classes } = useStyles();
  const [welcomeAlert, setWelcomeAlert] = useLocalStorage({
    key: 'welcomeAlert',
    defaultValue: true,
  });
  const { username, favorites, hidden } = router.query;

  const closeWelcomeAlert = () => setWelcomeAlert(false);

  return (
    <>
      <Meta
        title={`Civitai${
          !currentUser ? ` | Stable Diffusion models, embeddings, hypernetworks and more` : ''
        }`}
        description="Civitai is a platform for Stable Diffusion AI Art models. We have a collection of over 1,700 models from 250+ creators. We also have a collection of 1200 reviews from the community along with 12,000+ images with prompts to get you started."
      />
      <Container size="xl">
        {username && typeof username === 'string' && <Title>Models by {username}</Title>}
        {favorites && <Title>Your Liked Models</Title>}
        {hidden && <Title>Your Hidden Models</Title>}
        <Stack spacing="xs">
          {welcomeAlert && (
            <Alert
              color="blue"
              py={8}
              className={classes.welcome}
              onClose={closeWelcomeAlert}
              withCloseButton
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
          <TrendingTags />
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
    marginBottom: -25,
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
      marginBottom: -5,
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
