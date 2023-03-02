import { useRouter } from 'next/router';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { EditPostProvider } from '~/components/Post/EditPostProvider';
import { trpc } from '~/utils/trpc';

export function PostEditLayout(page: any) {
  const router = useRouter();
  const postId = router.query.postId ? Number(router.query.postId) : 0;

  const { data } = trpc.post.get.useQuery({ id: postId }, { enabled: postId > 0 });

  return (
    <AppLayout>
      <EditPostProvider post={data}>{page}</EditPostProvider>
    </AppLayout>
  );
}
