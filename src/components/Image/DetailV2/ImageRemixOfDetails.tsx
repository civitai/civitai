import { Card, Text } from '@mantine/core';
import { IconHierarchy } from '@tabler/icons-react';
import React, { useState } from 'react';
import { trpc } from '~/utils/trpc';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';

import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
export const ImageRemixOfDetails = ({ imageId }: { imageId: number }) => {
  const { data: imageGenerationData } = trpc.image.getGenerationData.useQuery({ id: imageId });
  const { remixOfId } = imageGenerationData ?? {};
  const { data: image, isLoading } = trpc.image.get.useQuery(
    { id: remixOfId },
    { enabled: !!remixOfId }
  );

  if (!remixOfId || !image) return null;

  return (
    <Card className="flex flex-col gap-3 rounded-xl">
      <div className="flex items-center gap-3">
        <Text className="flex items-center gap-2 text-xl font-semibold">
          <IconHierarchy />
          <span>Remixed From</span>
        </Text>
      </div>

      <AspectRatioImageCard
        image={image}
        href={`/images/${image.id}`}
        target="_blank"
        footer={
          <div className="flex w-full flex-col gap-2">
            <UserAvatarSimple {...image.user} />
          </div>
        }
      />
    </Card>
  );
};
