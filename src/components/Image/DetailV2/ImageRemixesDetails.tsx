import { Button, Card, Text } from '@mantine/core';
import { IconHierarchy } from '@tabler/icons-react';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { ImageSort } from '~/server/common/enums';
import { useQueryImages } from '../image.utils';

const MAX_SHOWN_IMAGES = 6;

export const ImageRemixesDetails = ({ imageId }: { imageId: number }) => {
  const { images, hasNextPage } = useQueryImages({
    remixOfId: imageId,
    period: 'AllTime',
    sort: ImageSort.MostReactions,
    // Fetch more than the max show images mainly due to filter settings.
    limit: 25,
    useIndex: true,
  });

  if ((images?.length ?? 0) === 0) return null;

  const data = images.slice(0, MAX_SHOWN_IMAGES);

  return (
    <Card className="flex flex-col gap-3 rounded-xl">
      <div className="flex items-center gap-3">
        <Text className="flex items-center gap-2 text-xl font-semibold">
          <IconHierarchy />
          <span>Remixes</span>
        </Text>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {data.map((image) => (
          <div key={image.id}>
            <RoutedDialogLink
              name="imageDetail"
              state={{
                imageId: image.id,
              }}
            >
              <AspectRatioImageCard image={image} aspectRatio="square" />
            </RoutedDialogLink>
          </div>
        ))}
      </div>
      {(hasNextPage || images.length > MAX_SHOWN_IMAGES) && (
        <Button
          component={Link}
          variant="outline"
          fullWidth
          radius="md"
          href={`/images?remixOfId=${imageId}`}
          target="_blank"
        >
          Check out more remixes
        </Button>
      )}
    </Card>
  );
};
