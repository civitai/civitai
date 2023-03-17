import { Grid, Stack, Title } from '@mantine/core';
import { EditPostControls } from '~/components/Post/Edit/EditPostControls';
import { EditPostDetail } from '~/components/Post/Edit/EditPostDetail';
import { EditPostImages } from '~/components/Post/Edit/EditPostImages';
import { EditPostReviews } from '~/components/Post/Edit/EditPostReviews';
import { EditPostTitle } from '~/components/Post/Edit/EditPostTitle';
import { ReorderImages } from '~/components/Post/Edit/ReorderImages';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';

export function PostEditComposite() {
  const reorder = useEditPostContext((state) => state.reorder);
  return (
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
  );
}
