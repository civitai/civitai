import { Card, Text, Button } from '@mantine/core';
import { IconHierarchy } from '@tabler/icons-react';
import React, { useState } from 'react';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { ImageSort } from '~/server/common/enums';
import { useQueryImages } from '../image.utils';
import { NextLink as Link } from '~/components/NextLink/NextLink';

export const ImageRemixesDetails = ({ imageId }: { imageId: number }) => {
  const { images, hasNextPage } = useQueryImages({
    remixOfId: imageId,
    period: 'AllTime',
    sort: ImageSort.MostReactions,
    limit: 6,
    useIndex: true,
  });

  if ((images?.length ?? 0) === 0) return null;

  return (
    <Card className="flex flex-col gap-3 rounded-xl">
      <div className="flex items-center gap-3">
        <Text className="flex items-center gap-2 text-xl font-semibold">
          <IconHierarchy />
          <span>Remixed by</span>
        </Text>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {images.map((image) => (
          <div key={image.id}>
            <AspectRatioImageCard
              image={image}
              href={`/images/${image.id}`}
              target="_blank"
              aspectRatio="square"
            />
          </div>
        ))}
      </div>
      {hasNextPage && (
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
