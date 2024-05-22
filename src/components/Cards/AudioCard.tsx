import { Text } from '@mantine/core';
import { FeedCard } from '~/components/Cards/FeedCard';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { useImagesContext } from '~/components/Image/Providers/ImagesProvider';
import { ImagesInfiniteModel } from '~/server/services/image.service';

export function AudioCard({ data }: Props) {
  const context = useImagesContext();

  return (
    <RoutedDialogLink name="imageDetail" state={{ imageId: data.id, ...context }}>
      <FeedCard>
        <div className="flex size-full flex-col items-center justify-center rounded-lg bg-gray-800">
          <div className="flex size-16 items-center justify-center rounded-full bg-gray-600">
            <IconMusic color="white" size={24} />
          </div>
          <Text className="mt-4 text-sm font-semibold text-gray-300">{data.title}</Text>
        </div>
      </FeedCard>
    </RoutedDialogLink>
  );
}

type Props = { data: ImagesInfiniteModel };
