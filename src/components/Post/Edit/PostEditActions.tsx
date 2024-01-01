import { Button, Stack } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';

import { DeletePostButton } from '~/components/Post/DeletePostButton';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { ReorderImagesButton } from '~/components/Post/Edit/ReorderImages';

export function PostEditActions() {
  const id = useEditPostContext((state) => state.id);
  const setDeleting = useEditPostContext((state) => state.setDeleting);

  return (
    <Stack spacing="xs">
      <ReorderImagesButton />
      <DeletePostButton postId={id}>
        {({ onClick, isLoading }) => (
          <Button
            onClick={() => {
              onClick(setDeleting);
            }}
            color="red"
            loading={isLoading}
            variant="outline"
            leftIcon={<IconTrash size={20} />}
          >
            Delete Post
          </Button>
        )}
      </DeletePostButton>
    </Stack>
  );
}
