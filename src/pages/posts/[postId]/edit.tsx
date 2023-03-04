import { PostEditLayout } from '~/components/Post/Edit/PostEditLayout';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';
import { Container, Title, Stack, Grid, Button } from '@mantine/core';
import { EditPostImages } from '~/components/Post/Edit/EditPostImages';
import { EditPostTags } from '~/components/Post/Edit/EditPostTags';
import { EditPostTitle } from '~/components/Post/Edit/EditPostTitle';
import { ReorderImages, ReorderImagesButton } from '~/components/Post/Edit/ReorderImages';
import { DeletePostButton } from '~/components/Post/DeletePostButton';

export default function PostEdit() {
  const id = useEditPostContext((state) => state.id);
  const reorder = useEditPostContext((state) => state.reorder);
  return (
    <Container>
      <Grid gutter={30}>
        <Grid.Col md={4} sm={6} orderSm={2}>
          <Stack>
            <Title size="sm">POST</Title>
            <Button>To Community</Button>
            <EditPostTags />

            <ReorderImagesButton>
              {({ onClick, isLoading, reorder }) => (
                <Button onClick={onClick} loading={isLoading}>
                  {reorder ? 'Done rearranging' : 'Rearrange images'}
                </Button>
              )}
            </ReorderImagesButton>
            <DeletePostButton postId={id}>
              {({ onClick, isLoading }) => (
                <Button color="red" variant="filled" onClick={onClick} loading={isLoading}>
                  Delete Post
                </Button>
              )}
            </DeletePostButton>
          </Stack>
        </Grid.Col>
        <Grid.Col md={8} sm={6} orderSm={1}>
          <Stack>
            <EditPostTitle />
            {!reorder ? <EditPostImages /> : <ReorderImages />}
          </Stack>
        </Grid.Col>
      </Grid>
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
