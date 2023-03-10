import { Stack, Button } from '@mantine/core';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';

import { ReorderImagesButton } from '~/components/Post/Edit/ReorderImages';
import { DeletePostButton } from '~/components/Post/DeletePostButton';

export function PostEditActions() {
  const id = useEditPostContext((state) => state.id);
  return (
    <Stack spacing="xs">
      <ReorderImagesButton>
        {({ onClick, isLoading, isReordering, canReorder }) => (
          <Button onClick={onClick} disabled={!canReorder} loading={isLoading}>
            {isReordering ? 'Done Rearranging' : 'Rearrange'}
          </Button>
        )}
      </ReorderImagesButton>
      <DeletePostButton postId={id}>
        {({ onClick, isLoading }) => (
          <Button onClick={onClick} color="red" loading={isLoading}>
            Delete Post
          </Button>
        )}
      </DeletePostButton>
    </Stack>
  );
}
