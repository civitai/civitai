import { Center, Loader } from '@mantine/core';
import { useRouter } from 'next/router';
import React from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { PostEditProvider } from '~/components/Post/EditV2/PostEditProvider';
import { ScrollAreaMain } from '~/components/ScrollArea/ScrollAreaMain';
import { postEditQuerySchema } from '~/server/schema/post.schema';
import { trpc } from '~/utils/trpc';

export function PostEditLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const params = postEditQuerySchema.parse(router.query);
  const { postId = 0 } = params;

  const { data, isInitialLoading } = trpc.post.getEdit.useQuery(
    { id: postId },
    { enabled: postId > 0, keepPreviousData: false }
  );

  const isCreatePage = !postId;
  const is404 = !data && !isInitialLoading && !isCreatePage;
  const loading = isInitialLoading && !isCreatePage;

  return (
    <PostEditProvider post={data} params={params}>
      <ScrollAreaMain>
        {is404 ? (
          <NotFound />
        ) : loading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : (
          children
        )}
      </ScrollAreaMain>
    </PostEditProvider>
  );
}
