import { Group, Paper, createStyles } from '@mantine/core';
import { useRouter } from 'next/router';
import { useRef } from 'react';
import { ArticleFeedFilters } from '~/components/Filters/FeedFilters/ArticleFeedFilters';
import { BountyFeedFilters } from '~/components/Filters/FeedFilters/BountyFeedFilters';
import { ImageFeedFilters } from '~/components/Filters/FeedFilters/ImageFeedFilters';
import { ModelFeedFilters } from '~/components/Filters/FeedFilters/ModelFeedFilters';
import { PostFeedFilters } from '~/components/Filters/FeedFilters/PostFeedFilters';
import { VideoFeedFilters } from '~/components/Filters/FeedFilters/VideoFeedFilters';
import { ManageHomepageButton } from '~/components/HomeBlocks/ManageHomepageButton';
import { HomeTabs } from '~/components/HomeContentToggle/HomeContentToggle';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollArea';

const useStyles = createStyles((theme) => ({
  subNav: {
    position: 'sticky',
    top: 0,
    left: 0,
    zIndex: 100,
    padding: `0 ${theme.spacing.md}px`,
    borderRadius: 0,
    transition: 'transform 0.3s',
    background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1],
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
} as const;
type HomeSection = keyof typeof filtersBySection;
const sections = Object.keys(filtersBySection) as Array<HomeSection>;

export function SubNav() {
  const { classes } = useStyles();
  const router = useRouter();

  const currentScrollRef = useRef(0);
  const subNavRef = useRef<HTMLDivElement>(null);

  const currentPath = router.pathname.replace('/', '') || 'home';
  const isFeedPage = sections.includes(currentPath as HomeSection);

  const node = useScrollAreaRef({
    onScroll: () => {
      if (!node?.current) return;

      const scroll = node.current.scrollTop;
      if (currentScrollRef.current > 0 && scroll > currentScrollRef.current)
        subNavRef?.current?.style?.setProperty('transform', 'translateY(-200%)');
      else subNavRef?.current?.style?.setProperty('transform', 'translateY(0)');

      currentScrollRef.current = scroll;
    },
  });

  return (
    <Paper
      ref={subNavRef}
      className={classes.subNav}
      shadow="xs"
      py={4}
      px={8}
      mb={currentPath !== 'home' ? 'md' : undefined}
    >
      <Group spacing={8} position="apart" noWrap={currentPath === 'home'}>
        <HomeTabs />

        {isFeedPage && (filtersBySection[currentPath as HomeSection] ?? null)}
      </Group>
    </Paper>
  );
}
