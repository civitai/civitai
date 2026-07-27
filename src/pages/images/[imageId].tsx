import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { ImageDetailProvider } from '~/components/Image/Detail/ImageDetailProvider';
import { ImageDetail2 } from '~/components/Image/DetailV2/ImageDetail2';
import { imagesQueryParamSchema } from '~/components/Image/image.utils';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx, ssg, session }) => {
    const params = (ctx.params ?? {}) as { imageId: string };
    const id = Number(params.imageId);
    if (!isNumber(id)) return { notFound: true };

    const [image] = await Promise.all([
      ssg?.image.get.fetch({ id }).catch(() => null),
      ssg?.image.getGenerationData.prefetch({ id }),
      session ? ssg?.image.getContestCollectionDetails.prefetch({ id }) : null,
      ssg?.hiddenPreferences.getHidden.prefetch(),
    ]);

    // ImageDetail2 gates on `forcedBrowsingLevel || nsfwLevel`; the forced level comes from
    // contest-collection details, which aren't prefetched for logged-out users, so for the
    // traffic that matters the client lands on the same level we do.
    return {
      props: {},
      gating: image
        ? {
            contentNsfwLevel: image.nsfwLevel,
          }
        : undefined,
    };
  },
});

export default Page(
  function () {
    const router = useBrowserRouter();
    const imageId = router.query.imageId;
    const filters = imagesQueryParamSchema.parse(router.query);

    if (!imageId) return <NotFound />;

    return (
      <ImageDetailProvider key={imageId} imageId={imageId} filters={filters}>
        <ImageDetail2 />
      </ImageDetailProvider>
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
