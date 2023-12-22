import { Badge, Container, Group, Stack, Title } from '@mantine/core';
import { useIsMutating } from '@tanstack/react-query';

import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { EditPostControls } from '~/components/Post/Edit/EditPostControls';
import { EditPostDetail } from '~/components/Post/Edit/EditPostDetail';
import { EditPostImages } from '~/components/Post/Edit/EditPostImages';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { EditPostReviews } from '~/components/Post/Edit/EditPostReviews';
import { EditPostTitle } from '~/components/Post/Edit/EditPostTitle';
import { PostEditLayout } from '~/components/Post/Edit/PostEditLayout';
import { ReorderImages } from '~/components/Post/Edit/ReorderImages';
import { EditPostClubs } from '../../../components/Post/Edit/EditPostClubs';
import { useCatchNavigation } from '~/hooks/useCatchNavigation';

export default function PostEdit() {
  const mutating = useIsMutating();
  const reorder = useEditPostContext((state) => state.reorder);
  const publishedAt = useEditPostContext((state) => state.publishedAt);
  const deleting = useEditPostContext((state) => state.deleting);

  useCatchNavigation({
    unsavedChanges: !publishedAt && !deleting,
    message: `You haven't published this post, all images will stay hidden. Do you wish to continue?`,
  });

  return (
    <Container>
      <ContainerGrid gutter={30}>
        <ContainerGrid.Col md={4} sm={6} orderSm={2}>
          <Stack>
            <Group position="apart">
              <Title size="sm">POST</Title>
              <Badge color={mutating > 0 ? 'yellow' : 'green'} size="lg">
                {mutating > 0 ? 'Saving' : 'Saved'}
              </Badge>
            </Group>
            <EditPostControls />
            <EditPostClubs />
            <EditPostReviews />
          </Stack>
        </ContainerGrid.Col>
        <ContainerGrid.Col md={8} sm={6} orderSm={1}>
          <Stack>
            <EditPostTitle />
            <EditPostDetail />
            {!reorder ? <EditPostImages /> : <ReorderImages />}
          </Stack>
        </ContainerGrid.Col>
      </ContainerGrid>
    </Container>
  );
}

setPageOptions(PostEdit, { innerLayout: PostEditLayout });
// PostEdit.getLayout = PostEditLayout;
