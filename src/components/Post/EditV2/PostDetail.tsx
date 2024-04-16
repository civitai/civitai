import { Center, Container, Loader } from '@mantine/core';
import { useRouter } from 'next/router';

import { z } from 'zod';
import { PostDetailForm } from '~/components/Post/EditV2/PostDetailForm';
import { PostImages } from '~/components/Post/EditV2/PostImages';
import { trpc } from '~/utils/trpc';

const querySchema = z.object({ postId: z.coerce.number() });

export function PostDetail() {
  const router = useRouter();
  const { postId } = querySchema.parse(router.query);
  const { data, isLoading } = trpc.post.getEdit.useQuery({ id: postId });

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );

  if (!data) return null;

  return (
    <Container>
      <div className="flex flex-col gap-3">
        <PostDetailForm post={data} />
        <PostImages post={data} />
      </div>
    </Container>
  );
}
