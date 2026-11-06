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
import { AppsStoreFeedFilters } from '~/components/Apps/AppsStoreFeedFilters';
import { NavCustomizeNotice } from '~/components/Alerts/NavCustomizeNotice';
import { HomeTabs } from '~/components/HomeContentToggle/HomeContentToggle';
import { SubNavSettingsButton } from '~/components/HomeContentToggle/SubNavSettingsButton';
import { ToolImageFeedFilters } from '~/components/Filters/FeedFilters/ToolImageFeedFilters';
import { StorylineFeedFilters } from '~/components/Storyline/StorylineFeedFilters';
import clsx from 'clsx';

// The filter group is the wrapper's first child. It gives up its full-width rule to leave room for
// the gear: its gap closes, its buttons stop growing and may shrink with an ellipsis, and the
// trailing chevron goes. Signed in, the images feed's group (Everyone, sort, Filters) is the
// widest and only just fits at 390px, so these are all needed. Scoped here, not in
// `FeedFilters.module.scss`, because the same group renders full width inline elsewhere.
const PHONE_FILTER_ROW = [
  'contents @max-sm:flex @max-sm:w-full @max-sm:items-start @max-sm:gap-1',
  '@max-sm:[&>:first-child]:!gap-1 @max-sm:[&>:first-child]:w-auto @max-sm:[&>:first-child]:min-w-0 @max-sm:[&>:first-child]:flex-1',
  '@max-sm:[&>:first-child>*]:min-w-0 @max-sm:[&>:first-child>*]:grow-0',
  '@max-sm:[&>:first-child_button]:min-w-0 @max-sm:[&>:first-child_button]:max-w-full',
  '@max-sm:[&>:first-child_button>span]:min-w-0 @max-sm:[&>:first-child_button>span]:truncate',
  // Below 390px (the container's own width, as `@max-sm` is) the audience button keeps only its icon.
  '@max-[389px]:[&>:first-child_button[data-collapse-label]>span]:sr-only',
  '@max-sm:[&>:first-child_button>svg]:shrink-0 @max-sm:[&>:first-child_button>svg[data-chevron]]:hidden',
].join(' ');

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
  // The store's filters belong to the store (`/apps/store`); `/apps` is the viewer's app home.
  { pathname: '/apps/store', component: <AppsStoreFeedFilters ml="auto" /> },
  { pathname: '/storylines', component: <StorylineFeedFilters ml="auto" /> },
  // Matched on `router.pathname`, which is the ROUTE and not the URL, so this has
  // to carry the optional slug segment the hub route gained.
  // Desktop only: below `sm` these are full width (`FeedFilters.module.scss`) and
  // would sit under the site tabs as a band belonging to nothing, so the hub row
  // carries them there instead.
  {
    pathname: '/hubs/[id]/[[...slug]]',
    component: (
      <div className="ml-auto @max-sm:hidden">
        <HubFeedFilters />
      </div>
    ),
  },
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
      {section ? (
        // Below `sm` the feed filters and the gear share ONE row under the tabs, so the tabs row
        // keeps all its width to scroll in. `contents` leaves desktop as it was.
        <div className={PHONE_FILTER_ROW}>
          {section.component}
          {/* Pushes the gear right when the group is hidden on phones (the hub pages). */}
          <SubNavSettingsButton className="@max-sm:ml-auto" />
        </div>
      ) : (
        <SubNavSettingsButton withHomepageOption={router.pathname === '/'} className="ml-auto" />
      )}
    </div>
  );
}
