import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { ImageDetailProvider } from '~/components/Image/Detail/ImageDetailProvider';
import { ImageDetail2 } from '~/components/Image/DetailV2/ImageDetail2';
import { parseImageQueryParams } from '~/components/Image/image.utils';
import { StorylineModeProvider } from '~/components/Storyline/StorylineModeProvider';
import { resolveImageDetailPageData } from '~/server/page-data/image-detail';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  // 'always': ad gating, and any notFound or redirect, is decided from the prefetched entity, so a
  // client navigation must prefetch too.
  prefetch: 'always',
  useSession: true,
  // Shared with `GET /api/page-data/images/[imageId]`; see `~/server/page-data/image-detail`.
  resolver: resolveImageDetailPageData,
});

export default Page(
  function () {
    const router = useBrowserRouter();
    const imageId = router.query.imageId;
    // Not `imagesQueryParamSchema.parse` — a throw here is a 500, and this page is the
    // destination of notification links carrying `?postId=null`. See parseImageQueryParams.
    const filters = parseImageQueryParams(router.query);

    if (!imageId) return <NotFound />;

    return (
      <StorylineModeProvider>
        {(storylineImages, modeKey) => (
          <ImageDetailProvider
            key={`${imageId}-${modeKey}`}
            imageId={imageId}
            filters={filters}
            images={storylineImages}
          >
            <ImageDetail2 />
          </ImageDetailProvider>
        )}
      </StorylineModeProvider>
    );
  },
  {
    header: null,
    footer: null,
    subNav: null,
    scrollable: false,
    announcements: false,
  }
);
