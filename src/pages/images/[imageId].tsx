import { useRouter } from 'next/router';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { QS } from '~/utils/qs';

export default function ImagePage() {
  const router = useRouter();
  const imageId = Number(router.query.imageId);

  return <></>;
}

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const { imageId, ...params } = QS.parse(QS.stringify(ctx.params ?? {})) as {
      imageId: number;
    } & { [key: string]: unknown };
    // const params = (ctx.params ?? {}) as {
    //   imageId: string;
    //   postId: string;
    //   modelId: string;
    //   username: string | undefined;
    // };
    // const imageId = Number(params.imageId);
    // const postId = params.postId ? Number(params.postId) : undefined;
    // const modelId = params.modelId ? Number(params.modelId) : undefined;
    // const username = params.username;

    await ssg?.image.getInfinite.prefetchInfinite(params);
    await ssg?.image.getDetail.prefetch({ id: imageId });
  },
});
