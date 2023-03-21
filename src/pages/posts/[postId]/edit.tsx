import { Container, Grid, Stack, Title } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { EditPostControls } from '~/components/Post/Edit/EditPostControls';
import { EditPostDetail } from '~/components/Post/Edit/EditPostDetail';
import { EditPostImages } from '~/components/Post/Edit/EditPostImages';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { EditPostReviews } from '~/components/Post/Edit/EditPostReviews';
import { EditPostTitle } from '~/components/Post/Edit/EditPostTitle';
import { PostEditLayout } from '~/components/Post/Edit/PostEditLayout';
import { ReorderImages } from '~/components/Post/Edit/ReorderImages';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export default function PostEdit() {
  const reorder = useEditPostContext((state) => state.reorder);
  const features = useFeatureFlags();
  if (!features.posts) return <NotFound />;

  return (
    <Container>
      <Grid gutter={30}>
        <Grid.Col md={4} sm={6} orderSm={2}>
          <Stack>
            <Title size="sm">POST</Title>
            <EditPostControls />
            <EditPostReviews />
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
