import { useRouter } from 'next/router';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';
import { ImageDetail } from '~/components/Image/Detail/ImageDetail';
import { ImageDetailProvider } from '~/components/Image/Detail/ImageDetailProvider';

export default function ImagePage() {
  const router = useRouter();
  const imageId = Number(router.query.imageId);
  const modelId = router.query.modelId ? Number(router.query.modelId) : undefined;
  const modelVersionId = router.query.modelVersionId
    ? Number(router.query.modelVersionId)
    : undefined;
  const postId = router.query.postId ? Number(router.query.postId) : undefined;
  const username = router.query.username as string;

  return (
    <ImageDetailProvider
      imageId={imageId}
      modelId={modelId}
      modelVersionId={modelVersionId}
      postId={postId}
      username={username}
    >
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
