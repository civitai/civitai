import { Button } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { getModelUrl } from '~/utils/string-helpers';

export function PostEditModelLink({
  modelId,
  modelVersionId,
}: {
  modelId: number | null;
  modelVersionId: number | null;
}) {
  if (!modelId || !modelVersionId) return null;

  return (
    <Button
      component={Link}
      href={getModelUrl({ modelId, modelVersionId })}
      variant="default"
      leftSection={<IconArrowLeft size={20} />}
    >
      View Model
    </Button>
  );
}
