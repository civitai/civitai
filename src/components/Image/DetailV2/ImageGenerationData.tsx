import { Card, Divider, Text } from '@mantine/core';
import { IconForms } from '@tabler/icons-react';
import { ImageMeta } from '~/components/Image/DetailV2/ImageMeta';
import { ImageResources } from '~/components/Image/DetailV2/ImageResources';
import { trpc } from '~/utils/trpc';

export function ImageGenerationData({ imageId }: { imageId: number }) {
  const { data } = trpc.image.getGenerationData.useQuery({ id: imageId });

  if (!data) return null;
  const meta = data?.meta;

  return (
    <Card className="rounded-xl flex flex-col gap-3">
      <Text className="flex items-center gap-2 font-semibold text-xl">
        <IconForms />
        <span>Generation data</span>
      </Text>
      <ImageResources imageId={imageId} />
      {(meta?.prompt || meta?.negativePrompt) && <Divider />}
      <ImageMeta imageId={imageId} />
    </Card>
  );
}
