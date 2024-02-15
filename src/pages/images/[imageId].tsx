import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';
import { ImageDetail } from '~/components/Image/Detail/ImageDetail';
import { ImageDetailProvider } from '~/components/Image/Detail/ImageDetailProvider';
import { imagesQueryParamSchema } from '~/components/Image/image.utils';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { NotFound } from '~/components/AppLayout/NotFound';

export default function ImagePage() {
  const router = useBrowserRouter();
  const imageId = router.query.imageId;
  const filters = imagesQueryParamSchema.parse(router.query);

  if (!imageId) return <NotFound />;

  return (
    <ImageDetailProvider imageId={imageId} filters={filters}>
      <ImageDetail />
    </ImageDetailProvider>
  );
}

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const params = (ctx.params ?? {}) as { imageId: string };
    const id = Number(params.imageId);
    if (!isNumber(id)) return { notFound: true };

    await ssg?.image.get.prefetch({ id });
  },
});

setPageOptions(ImagePage, { withScrollArea: false });
