import { Group, Paper, createStyles } from '@mantine/core';
import { useRef } from 'react';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollArea';
import {
  HomeContentToggle,
  useHomeSelection,
} from '~/components/HomeContentToggle/HomeContentToggle';
import { ArticleFeedFilters } from '~/components/Filters/FeedFilters/ArticleFeedFilters';
import { BountyFeedFilters } from '~/components/Filters/FeedFilters/BountyFeedFilters';
import { ImageFeedFilters } from '~/components/Filters/FeedFilters/ImageFeedFilters';
import { ModelFeedFilters } from '~/components/Filters/FeedFilters/ModelFeedFilters';
import { PostFeedFilters } from '~/components/Filters/FeedFilters/PostFeedFilters';
import { VideoFeedFilters } from '~/components/Filters/FeedFilters/VideoFeedFilters';
import { ManageHomepageButton } from '~/components/HomeBlocks/ManageHomepageButton';
import { useRouter } from 'next/router';

const useStyles = createStyles(() => ({
  subNav: {
    position: 'sticky',
    top: 0,
    left: 0,
    zIndex: 10,
    transition: 'transform 0.3s',
  },
}));

const filtersBySection = {
  home: <ManageHomepageButton ml="auto" />,
  models: <ModelFeedFilters ml="auto" />,
  images: <ImageFeedFilters ml="auto" />,
  videos: <VideoFeedFilters ml="auto" />,
  posts: <PostFeedFilters ml="auto" />,
  articles: <ArticleFeedFilters ml="auto" />,
  bounties: <BountyFeedFilters ml="auto" />,
  events: null,
};

export function SubNav() {
  const { classes } = useStyles();
  const router = useRouter();

  const currentScroll = useRef(0);
  const subNavRef = useRef<HTMLDivElement>(null);

  const { home } = useHomeSelection();
  const currentPath = router.pathname.replace('/', '') || 'home';
  const isFeedPage = home === currentPath;

  const node = useScrollAreaRef({
    onScroll: () => {
      if (!node?.current) return;

      const scroll = node.current.scrollTop;
      if (scroll > currentScroll.current)
        subNavRef?.current?.style?.setProperty('transform', 'translateY(-200%)');
      else subNavRef?.current?.style?.setProperty('transform', 'translateY(0)');

      currentScroll.current = scroll;
    },
  });

  return (
    <Paper
      ref={subNavRef}
      className={classes.subNav}
      shadow="xs"
      px={8}
      py={4}
      mb={home !== 'home' ? 'md' : undefined}
    >
      <Group spacing={8} position="apart">
        <HomeContentToggle p={0} />

        {home && isFeedPage && (filtersBySection[home] ?? null)}
      </Group>
    </Paper>
  );
}
