import { Anchor, Center, Container, Stack, Tabs, Text, Title } from '@mantine/core';
import { useMemo } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { FeaturedArticle } from '~/components/Newsroom/FeaturedArticle';
import { MediaKit } from '~/components/Newsroom/MediaKit';
import { News } from '~/components/Newsroom/News';
import { PressMentions } from '~/components/Newsroom/PressMentions';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import classes from './index.module.scss';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    if (ssg) {
      await ssg.article.getCivitaiNews.prefetch();
    }
  },
});

export default function CivitaiNewsroom() {
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
      <Meta title="Civitai Newsroom" description="The latest news and updates from Civitai" />
      <div className={classes.hero}>
        <Container size="md">
          <Stack align="center" gap={0}>
            <Title className={classes.heroTitle}>Civitai Newsroom</Title>
            <Text ta="center" className={classes.heroText}>
              The latest news and updates from Civitai.
              <br />
              For press inquiries, please complete{' '}
              <Anchor component="a" href="/content/press-inquiry">
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
          defaultValue="news"
          classNames={{
            list: classes.tabsList,
            tab: classes.tab,
          }}
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
