import { useRouter } from 'next/router';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';
import { ImageDetail } from '~/components/Image/Detail/ImageDetail';
import { ImageDetailProvider } from '~/components/Image/Detail/ImageDetailProvider';
import { useImageQueryParams } from '~/components/Image/image.utils';

export default function ImagePage() {
  const router = useRouter();
  const imageId = Number(router.query.imageId);
  const { query } = useImageQueryParams();

  return (
    <ImageDetailProvider imageId={imageId} filters={query}>
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

ImagePage.getLayout = (page: any) => <>{page}</>;
