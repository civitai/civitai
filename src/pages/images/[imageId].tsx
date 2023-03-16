import { useRouter } from 'next/router';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export default function ImagePage() {
  const router = useRouter();
  const imageId = Number(router.query.imageId);

  return <></>;
}

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const params = (ctx.params ?? {}) as { postId: string; modelId: string; username: string };
    const postId = Number(params.postId);

    await ssg?.image.getInfinite.prefetchInfinite({ postId });
  },
});
