import { useRouter } from 'next/router';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { EditPostProvider } from '~/components/Post/EditPostProvider';
import { trpc } from '~/utils/trpc';
import { useEffect } from 'react';

export function PostEditLayout(page: any) {
  const router = useRouter();
  const postId = router.query.postId ? Number(router.query.postId) : 0;
  const queryUtils = trpc.useContext();

  const { data } = trpc.post.get.useQuery({ id: postId }, { enabled: postId > 0 });

  useEffect(() => {
    router.beforePopState(({ as }) => {
      if (as !== router.asPath && postId) {
        queryUtils.post.get.invalidate({ id: postId });
        // TODO.posts - additional post invalidation here
      }
      return true;
    });
    return () => router.beforePopState(() => true);
  }, [postId]); //eslint-disable-line

  return (
    <AppLayout>
      <EditPostProvider post={data}>{page}</EditPostProvider>
    </AppLayout>
  );
}
