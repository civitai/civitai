import { Card, Text } from '@mantine/core';
import { IconForms } from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';

export function ImageExternalMeta({ imageId }: { imageId: number }) {
  const { data } = trpc.image.getGenerationData.useQuery({ id: imageId });

  const { external } = data ?? {};
  if (!external) return null;

  return (
    <Card className="rounded-xl flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Text className="flex items-center gap-2 font-semibold text-xl">
          <IconForms />
          <span>External meta data</span>
        </Text>
      </div>
    </Card>
  );
}
