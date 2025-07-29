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

    await ssg?.image.get.prefetch({ id });

    if (session) {
      await ssg?.image.getContestCollectionDetails.prefetch({ id });
    }

    await ssg?.hiddenPreferences.getHidden.prefetch();
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
