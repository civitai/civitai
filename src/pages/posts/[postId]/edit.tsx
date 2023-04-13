import { Container, Grid, Stack, Title, Group, Badge } from '@mantine/core';
import { IconExclamationCircle } from '@tabler/icons';
import { useIsMutating } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { EditPostControls } from '~/components/Post/Edit/EditPostControls';
import { EditPostDetail } from '~/components/Post/Edit/EditPostDetail';
import { EditPostImages } from '~/components/Post/Edit/EditPostImages';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { EditPostReviews } from '~/components/Post/Edit/EditPostReviews';
import { EditPostTitle } from '~/components/Post/Edit/EditPostTitle';
import { PostEditLayout } from '~/components/Post/Edit/PostEditLayout';
import { ReorderImages } from '~/components/Post/Edit/ReorderImages';

export default function PostEdit() {
  const mutating = useIsMutating();
  const router = useRouter();
  const reviewing = router.query.reviewing ? router.query.reviewing === 'true' : undefined;

  const reorder = useEditPostContext((state) => state.reorder);
  const tags = useEditPostContext((state) => state.tags);

  return (
    <Container>
      {reviewing && !tags.length && (
        <DismissibleAlert
          id="complete-review"
          title="Complete your review"
          mx="auto"
          maw={400}
          mb="xl"
          size="md"
          color="blue"
          emoji="⭐️"
          content="To complete your review give your post a tag and hit publish."
        />
      )}
      <Grid gutter={30}>
        <Grid.Col md={4} sm={6} orderSm={2}>
          <Stack>
            <Group position="apart">
              <Title size="sm">POST</Title>
              <Badge color={mutating > 0 ? 'yellow' : 'green'} size="lg">
                {mutating > 0 ? 'Saving' : 'Saved'}
              </Badge>
            </Group>
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
