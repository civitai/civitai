import { PostEditLayout } from '~/components/Post/PostEditLayout';
import { trpc } from '~/utils/trpc';
import { useEditPostContext } from '~/components/Post/EditPostProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';
import { Container, Title, Stack } from '@mantine/core';
import EditPostImages from '~/components/Post/EditPostImages';

export default function PostEdit() {
  const id = useEditPostContext((state) => state.id);
  return (
    <Container size="xs">
      <Stack>
        <Title>PostId: {id}</Title>
        <EditPostImages />
      </Stack>
    </Container>
  );
}

PostEdit.getLayout = PostEditLayout;

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  prefetch: 'always',
  resolver: async ({ ctx, ssg }) => {
    const params = (ctx.params ?? {}) as { postId: string };
    const id = Number(params.postId);
    if (!isNumber(id)) return { notFound: true };

    await ssg?.post.get.prefetch({ id });
  },
});
