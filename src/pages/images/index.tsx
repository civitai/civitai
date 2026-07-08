import { Title } from '@mantine/core';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { useImageQueryParams } from '~/components/Image/image.utils';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import {
  createServerSideProps,
  prefetchImagesFeedQueries,
} from '~/server/utils/server-side-helpers';

// SSR-prefetch the INITIAL anon `image.getInfinite` feed query so it hydrates
// from the page HTML instead of firing a client→CF→origin round-trip on mount
// (flag-gated, anon-only, best-effort — see `prefetchImagesFeedQueries`).
//
// NOTE ON RENDERING MODEL: `/images` previously had NO data method. It was NOT
// statically CDN-cached, though — `MyApp.getInitialProps` (src/pages/_app.tsx)
// disables Next.js Automatic Static Optimization app-wide, so this page already
// rendered per-request on the SSR pod (like the homepage `/`, which likewise
// uses `createServerSideProps`). Adding GSSP therefore strips NO edge caching;
// it adds only the resolver's `getServerAuthSession` + `getFeatureFlagsAsync`
// (the same cost the homepage already pays). Flux/CDN cache-control is unchanged.
export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg, session, features }) => {
    // `ssg` exists only on full SSR (never a client-nav `/_next/data` fetch), and
    // the prefetch is gated on the dark, independently-ramped flag. Flag OFF (the
    // default) → zero added backend work; the page render / props are unaffected.
    if (ssg && features?.ssrPrefetchImagesFeed) {
      await prefetchImagesFeedQueries(ssg, session ?? null);
    }
  },
});

export default Page(
  function () {
    const { query } = useImageQueryParams();
    const { hidden } = query;

    return (
      <>
        <Meta
          title="AI Art Gallery | Civitai"
          description="Explore millions of AI-generated images created with Stable Diffusion, Flux, and other models. Discover prompts, techniques, and inspiration."
          canonical="/images"
        />
        {/* <ToolBanner /> */}
        <MasonryContainer className="min-h-full">
          {/* <Announcements /> */}
          {hidden && <Title>Your Hidden Images</Title>}
          <div className="flex flex-col gap-2.5">
            <ImageCategories />
            <ImagesInfinite showEof showAds />
          </div>
        </MasonryContainer>
      </>
    );
  },
  { InnerLayout: FeedLayout, announcements: true }
);
