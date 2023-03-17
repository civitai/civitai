import { useRouter } from 'next/router';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { EditPostProvider } from './EditPostProvider';
import { trpc } from '~/utils/trpc';
import { useEffect } from 'react';
import { Center, Loader } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';

// It turns out, you can't use hooks in a layout component
// https://github.com/vercel/next.js/discussions/36341#discussioncomment-2628008
export function PostEditLayout(page: any) {
  return (
    <AppLayout>
      <PostEditWrapper>{page}</PostEditWrapper>
    </AppLayout>
  );
}

export function PostEditWrapper({
  children,
  postId: initialPostId,
}: {
  children: any;
  postId?: number;
}) {
  const router = useRouter();
  const postId = initialPostId ?? router.query.postId ? Number(router.query.postId) : 0;
  const queryUtils = trpc.useContext();

  const { data, isLoading, isRefetching } = trpc.post.getEdit.useQuery(
    { id: postId },
    { enabled: postId > 0, keepPreviousData: false }
  );

  useEffect(() => {
    if (postId) {
      const handleReturn = async () => {
        await queryUtils.post.get.invalidate({ id: postId });
        await queryUtils.post.getEdit.invalidate({ id: postId });
        await queryUtils.post.getInfinite.invalidate();
        await queryUtils.image.getInfinite.invalidate({ postId });
      };
      return () => {
        handleReturn();
      };
    }
  }, [postId]); // eslint-disable-line

  const isCreatePage = !postId;
  const is404 = !data && !isLoading && !isCreatePage;
  const loading = (isLoading || isRefetching) && !isCreatePage;

  return is404 ? (
    <NotFound />
  ) : loading ? (
    <Center p="xl">
      <Loader />
    </Center>
  ) : (
    <EditPostProvider post={data}>{children}</EditPostProvider>
  );
}
