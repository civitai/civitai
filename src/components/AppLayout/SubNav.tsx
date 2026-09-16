import { useRouter } from 'next/router';
import { ArticleFeedFilters } from '~/components/Filters/FeedFilters/ArticleFeedFilters';
import { BountyFeedFilters } from '~/components/Filters/FeedFilters/BountyFeedFilters';
import { ComicFeedFilters } from '~/components/Filters/FeedFilters/ComicFeedFilters';
import { HubFeedFilters } from '~/components/Filters/FeedFilters/HubFeedFilters';

import { ImageFeedFilters } from '~/components/Filters/FeedFilters/ImageFeedFilters';
import { Model3DFeedFilters } from '~/components/Filters/FeedFilters/Model3DFeedFilters';
import { ModelFeedFilters } from '~/components/Filters/FeedFilters/ModelFeedFilters';
import { PostFeedFilters } from '~/components/Filters/FeedFilters/PostFeedFilters';
import { VideoFeedFilters } from '~/components/Filters/FeedFilters/VideoFeedFilters';
import { ToolFeedFilters } from '~/components/Filters/FeedFilters/ToolFeedFilters';
import { NavCustomizeNotice } from '~/components/Alerts/NavCustomizeNotice';
import { HomeTabs } from '~/components/HomeContentToggle/HomeContentToggle';
import { SubNavSettingsButton } from '~/components/HomeContentToggle/SubNavSettingsButton';
import { ToolImageFeedFilters } from '~/components/Filters/FeedFilters/ToolImageFeedFilters';
import clsx from 'clsx';

const filterSections = [
  { pathname: '/models', component: <ModelFeedFilters ml="auto" /> },
  { pathname: '/images', component: <ImageFeedFilters ml="auto" hideMediaTypes /> },
  { pathname: '/videos', component: <VideoFeedFilters ml="auto" /> },
  { pathname: '/3d-models', component: <Model3DFeedFilters ml="auto" /> },
  { pathname: '/posts', component: <PostFeedFilters ml="auto" /> },
  { pathname: '/articles', component: <ArticleFeedFilters ml="auto" /> },
  { pathname: '/bounties', component: <BountyFeedFilters ml="auto" /> },
  // /challenges renders its sort/filters inline with the Community Challenges section instead.
  { pathname: '/tools', component: <ToolFeedFilters ml="auto" /> },
  { pathname: '/tools/[slug]', component: <ToolImageFeedFilters ml="auto" /> },
  { pathname: '/comics', component: <ComicFeedFilters ml="auto" /> },
  // Matched on `router.pathname`, which is the ROUTE and not the URL, so this has
  // to carry the optional slug segment the hub route gained.
  { pathname: '/hubs/[id]/[[...slug]]', component: <HubFeedFilters ml="auto" /> },
];

export function SubNav2() {
  const router = useRouter();
  const section = filterSections.find((x) => x.pathname === router.pathname);

  return (
    // `items-start`, not `items-center`: `HomeTabs` is a horizontal scroller, and on platforms
    // that draw classic (space-consuming) scrollbars it is taller than its pills by the scrollbar's
    // height. Centring put the filters and the gear half a scrollbar below the tabs. Justin asked
    // for them level with the tabs (2026-09-15), which is the top edge.
    //
    // The scrollbar itself is deliberately NOT hidden. It is the only thing telling anyone the row
    // scrolls, and "it doesn't look like it scrolls" was the original report. `scrollbar-none` here
    // would take the 4px back and re-break that — the sibling row in `HomeStyleSegmentedControl`
    // styles its scrollbar rather than removing it, if a thinner one is ever wanted.
    <div
      className={clsx('flex items-start justify-between gap-2 px-2 py-1', {
        ['flex-wrap']: router.pathname !== '/',
      })}
    >
      <HomeTabs />
      <NavCustomizeNotice />
      {section?.component}
      <SubNavSettingsButton
        withHomepageOption={router.pathname === '/'}
        className={section ? undefined : 'ml-auto'}
      />
    </div>
  );
}
