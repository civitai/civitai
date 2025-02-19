import { Card, Text } from '@mantine/core';
import { IconHierarchy } from '@tabler/icons-react';
import { ImageCard } from '~/components/Cards/ImageCard';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { trpc } from '~/utils/trpc';

export const ImageRemixOfDetails = ({ imageId }: { imageId: number }) => {
  const { data: imageGenerationData } = trpc.image.getGenerationData.useQuery({ id: imageId });
  const { remixOfId } = imageGenerationData ?? {};
  const { data, isLoading } = trpc.image.get.useQuery(
    { id: remixOfId as number },
    { enabled: !!remixOfId }
  );

  // Avoids showing not available levels:
  const { items: images } = useApplyHiddenPreferences({
    type: 'images',
    data: data ? [data] : [],
    allowLowerLevels: true,
  });

  const [image] = images;

  if (!remixOfId || isLoading || !image) return null;

  return (
    <Card className="flex flex-col gap-3 rounded-xl">
      <div className="flex items-center gap-3">
        <Text className="flex items-center gap-2 text-xl font-semibold">
          <IconHierarchy />
          <span>Remixed From</span>
        </Text>
      </div>

      <ImageCard data={image} />
    </Card>
  );
};
