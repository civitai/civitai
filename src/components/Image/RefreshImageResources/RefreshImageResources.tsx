import { trpc } from '~/utils/trpc';
import { ActionIcon } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import type { ImageResourceHelper } from '~/shared/utils/prisma/models';

export function RefreshImageResources({
  imageId,
  onSuccess,
}: {
  imageId: number;
  onSuccess?: (imageResources: ImageResourceHelper[]) => void;
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
