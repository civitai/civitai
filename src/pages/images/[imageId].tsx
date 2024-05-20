import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';
import { ImageDetailProvider } from '~/components/Image/Detail/ImageDetailProvider';
import { imagesQueryParamSchema } from '~/components/Image/image.utils';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ImageDetail2 } from '~/components/Image/DetailV2/ImageDetail2';
import { createPage } from '~/components/AppLayout/createPage';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const params = (ctx.params ?? {}) as { imageId: string };
    const id = Number(params.imageId);
    if (!isNumber(id)) return { notFound: true };

    await ssg?.image.get.prefetch({ id });
  },
});

export default createPage(
  function ImagePage() {
    const router = useBrowserRouter();
    const imageId = router.query.imageId;
    const filters = imagesQueryParamSchema.parse(router.query);

    if (!imageId) return <NotFound />;

    return (
      <ImageDetailProvider imageId={imageId} filters={filters}>
        <ImageDetail2 />
      </ImageDetailProvider>
    );
  },
  { layout: ({ children }) => <main className="h-full w-full">{children}</main> }
);
