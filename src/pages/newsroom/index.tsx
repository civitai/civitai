import { Anchor, Center, Container, createStyles, Stack, Tabs, Text, Title } from '@mantine/core';
import { useMemo } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { FeaturedArticle } from '~/components/Newsroom/FeaturedArticle';
import { MediaKit } from '~/components/Newsroom/MediaKit';
import { News } from '~/components/Newsroom/News';
import { PressMentions } from '~/components/Newsroom/PressMentions';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { containerQuery } from '~/utils/mantine-css-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    if (ssg) {
      await ssg.article.getCivitaiNews.prefetch();
    }
  },
});

export default function CivitaiNewsroom() {
  const { classes } = useStyles();
  const { data } = trpc.article.getCivitaiNews.useQuery(undefined, {
    trpc: { context: { skipBatch: true } },
  });
  const news = useMemo(
    () => data?.articles.filter((x) => x.type === 'news') ?? [],
    [data?.articles]
  );
  const updates = useMemo(
    () => data?.articles.filter((x) => x.type === 'updates') ?? [],
    [data?.articles]
  );
  const pressMentions = data?.pressMentions ?? [];
  const featuredArticle = useMemo(() => news.find((article) => article.featured), [news]);
  const features = useFeatureFlags();
  if (!features.newsroom) return <NotFound />;

  return (
    <>
      <div className={classes.hero}>
        <Container size="md">
          <Stack align="center" spacing={0}>
            <Title className={classes.heroTitle}>Civitai Newsroom</Title>
            <Text ta="center" className={classes.heroText}>
              The latest news and updates from Civitai.
              <br />
              For press inquiries, please complete{' '}
              <Anchor component="a" href="/forms/press-inquiry" target="_blank">
                our inquiry form
              </Anchor>
              .
            </Text>

            {/* Featured Item Highlight */}
            {featuredArticle && (
              <FeaturedArticle article={featuredArticle} className={classes.heroArticle} />
            )}
          </Stack>
        </Container>
      </div>
      <Container>
        <Tabs
          variant="pills"
          defaultValue={'news'}
          styles={(theme) => ({
            tabsList: {
              gap: theme.spacing.sm,
              width: '100%',
              [containerQuery.largerThan('md')]: {
                gap: theme.spacing.md,
                width: 'auto',
              },
            },
            tab: {
              backgroundColor:
                theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
              color: theme.colorScheme === 'dark' ? theme.colors.dark[0] : theme.colors.gray[9],
              padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
              textAlign: 'center',
              flex: 1,
              fontSize: theme.fontSizes.md,

              '&:disabled': {
                opacity: 0.5,
                cursor: 'not-allowed',
              },

              '&[data-active]': {
                backgroundColor: theme.colors.blue[7],
                borderColor: theme.colors.blue[7],
                color: theme.white,
                fontWeight: 500,
              },
              [containerQuery.largerThan('md')]: {
                width: 200,
                padding: `${theme.spacing.md}px 0`,
              },
            },
          })}
        >
          <Stack>
            <Center>
              <Tabs.List mb="xl">
                <Tabs.Tab value="news">News</Tabs.Tab>
                <Tabs.Tab value="updates">Updates</Tabs.Tab>
                <Tabs.Tab value="press-mentions">Press Mentions</Tabs.Tab>
                <Tabs.Tab value="media-kit">Media Kit</Tabs.Tab>
              </Tabs.List>
            </Center>
            <Tabs.Panel value="news">
              <News articles={news} />
            </Tabs.Panel>
            <Tabs.Panel value="updates">
              <News articles={updates} />
            </Tabs.Panel>
            <Tabs.Panel value="press-mentions">
              <PressMentions pressMentions={pressMentions} />
            </Tabs.Panel>
            <Tabs.Panel value="media-kit">
              <MediaKit />
            </Tabs.Panel>
          </Stack>
        </Tabs>
      </Container>
    </>
  );
}

const useStyles = createStyles((theme) => ({
  hero: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    marginTop: -theme.spacing.md,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    overflow: 'hidden',
    marginBottom: theme.spacing.xl * 2,
    padding: `${theme.spacing.xl}px 0 ${theme.spacing.xl * 2}px`,
    containerType: 'inline-size',
    [containerQuery.largerThan('md')]: {
      padding: `${theme.spacing.xl}px 0 ${theme.spacing.xl * 3}px`,
    },
  },
  heroTitle: {
    fontSize: '2rem',
    fontWeight: 500,
    [containerQuery.largerThan('md')]: {
      fontSize: '4rem',
    },
  },
  heroText: {
    fontSize: theme.fontSizes.md,
    [containerQuery.largerThan('md')]: {
      fontSize: theme.fontSizes.lg,
    },
  },
  heroArticle: {
    marginTop: theme.spacing.lg,
    [containerQuery.largerThan('md')]: {
      marginTop: theme.spacing.xl * 2,
    },
  },
}));
