import { PostEditLayout } from '~/components/Post/Edit/PostEditLayout';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { Container, Title, Stack, Grid } from '@mantine/core';
import { EditPostImages } from '~/components/Post/Edit/EditPostImages';
import { EditPostTitle } from '~/components/Post/Edit/EditPostTitle';
import { ReorderImages } from '~/components/Post/Edit/ReorderImages';
import { EditPostControls } from '~/components/Post/Edit/EditPostControls';
import { EditPostReviews } from '~/components/Post/Edit/EditPostReviews';
import { EditPostDetail } from '~/components/Post/Edit/EditPostDetail';

export default function PostEdit() {
  const reorder = useEditPostContext((state) => state.reorder);
  return (
    <Container>
      <Grid gutter={30}>
        <Grid.Col md={4} sm={6} orderSm={2}>
          <Stack>
            <Title size="sm">POST</Title>
            <EditPostControls />
            {/* <EditPostReviews /> */}
          </Stack>
        </Grid.Col>
        <Grid.Col md={8} sm={6} orderSm={1}>
          <Stack>
            <EditPostTitle />
            <EditPostDetail />
            {!reorder ? <EditPostImages /> : <ReorderImages />}
          </Stack>
        </Grid.Col>
      </Grid>
    </Container>
  );
}

PostEdit.getLayout = PostEditLayout;
