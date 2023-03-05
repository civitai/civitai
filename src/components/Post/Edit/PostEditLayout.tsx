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
      <LayoutProvider>{page}</LayoutProvider>
    </AppLayout>
  );
}

function LayoutProvider({ children }: { children: any }) {
  const router = useRouter();
  const postId = router.query.postId ? Number(router.query.postId) : 0;
  const queryUtils = trpc.useContext();

  const { data, isLoading } = trpc.post.get.useQuery(
    { id: postId },
    { enabled: postId > 0, keepPreviousData: false }
  );

  useEffect(() => {
    const handleRouteChange = async (url: string) => {
      if (url !== router.asPath && postId) {
        console.log('should invalidate');
        queryUtils.post.get.invalidate({ id: postId });
        // TODO.posts - additional post invalidation here
      }
    };

    router.events.on('routeChangeStart', handleRouteChange);
    return () => {
      router.events.off('routeChangeStart', handleRouteChange);
    };
  }, [postId]); //eslint-disable-line

  const isCreatePage = !postId;
  const is404 = !data && !isLoading && !isCreatePage;
  const loading = isLoading && !isCreatePage;

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
