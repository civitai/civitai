import { trpc } from '~/utils/trpc';
import { ActionIcon } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import type { ImageResourceSlim } from '~/shared/types/image.types';

export function RefreshImageResources({
  imageId,
  onSuccess,
}: {
  imageId: number;
  onSuccess?: (imageResources: ImageResourceSlim[]) => void;
}) {
  const { mutate, isLoading } = trpc.image.refreshImageResources.useMutation({
    onSuccess: (data) => onSuccess?.(data),
  });

  return (
    <ActionIcon onClick={() => mutate({ id: imageId })} loading={isLoading}>
      <IconRefresh />
    </ActionIcon>
  );
}
