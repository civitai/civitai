import { useRouter } from 'next/router';
import { ArticleFeedFilters } from '~/components/Filters/FeedFilters/ArticleFeedFilters';
import { BountyFeedFilters } from '~/components/Filters/FeedFilters/BountyFeedFilters';

import { ChallengeFeedFilters } from '~/components/Filters/FeedFilters/ChallengeFeedFilters';
import { ImageFeedFilters } from '~/components/Filters/FeedFilters/ImageFeedFilters';
import { ModelFeedFilters } from '~/components/Filters/FeedFilters/ModelFeedFilters';
import { PostFeedFilters } from '~/components/Filters/FeedFilters/PostFeedFilters';
import { VideoFeedFilters } from '~/components/Filters/FeedFilters/VideoFeedFilters';
import { ToolFeedFilters } from '~/components/Filters/FeedFilters/ToolFeedFilters';
import { ManageHomepageButton } from '~/components/HomeBlocks/ManageHomepageButton';
import { HomeTabs } from '~/components/HomeContentToggle/HomeContentToggle';
import { ToolImageFeedFilters } from '~/components/Filters/FeedFilters/ToolImageFeedFilters';
import clsx from 'clsx';

const filterSections = [
  { pathname: '/', component: <ManageHomepageButton ml="auto" /> },
  { pathname: '/models', component: <ModelFeedFilters ml="auto" /> },
  { pathname: '/images', component: <ImageFeedFilters ml="auto" /> },
  { pathname: '/videos', component: <VideoFeedFilters ml="auto" /> },
  { pathname: '/posts', component: <PostFeedFilters ml="auto" /> },
  { pathname: '/articles', component: <ArticleFeedFilters ml="auto" /> },
  { pathname: '/bounties', component: <BountyFeedFilters ml="auto" /> },
  { pathname: '/challenges', component: <ChallengeFeedFilters ml="auto" /> },
  { pathname: '/tools', component: <ToolFeedFilters ml="auto" /> },
  { pathname: '/tools/[slug]', component: <ToolImageFeedFilters ml="auto" /> },
];

export function SubNav2() {
  const router = useRouter();
  const section = filterSections.find((x) => x.pathname === router.pathname);

  return (
    <div
      className={clsx('flex items-center justify-between gap-2 px-2 py-1', {
        ['flex-wrap']: router.pathname !== '/',
      })}
    >
      <HomeTabs />
      {section?.component}
    </div>
  );
}
