import { Button, Title, Badge } from '@mantine/core';
import { useIsMutating } from '@tanstack/react-query';
import { usePostEditContext } from '~/components/Post/EditV2/PostEditProvider';

export function PostEditSidebar() {
  const mutating = useIsMutating();
  const { post, params } = usePostEditContext();

  return (
    <>
      <div className="flex justify-between items-center">
        <Title size="sm">POST</Title>
        <Badge color={mutating > 0 ? 'yellow' : 'green'} size="lg">
          {mutating > 0 ? 'Saving' : 'Saved'}
        </Badge>
      </div>
      <Button>Publish</Button>
    </>
  );
}
