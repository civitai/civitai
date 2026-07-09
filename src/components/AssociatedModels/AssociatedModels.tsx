import { Button, Group, LoadingOverlay, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import type { AssociationType } from '~/shared/utils/prisma/enums';
import { IconRocketOff } from '@tabler/icons-react';
import React from 'react';
import dynamic from 'next/dynamic';
import { useQueryRecommendedResources } from '~/components/AssociatedModels/recommender.utils';

import { ArticleCard } from '~/components/Cards/ArticleCard';
import { ModelCard } from '~/components/Cards/ModelCard';
import { MasonryCarousel } from '~/components/MasonryColumns/MasonryCarousel';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const AssociateModelsModal = dynamic(() => import('~/components/Modals/AssociateModelsModal'), {
  ssr: false,
});
const openAssociateModelsModal = createDialogTrigger(AssociateModelsModal);

export function AssociatedModels({
  fromId,
  type,
  label,
  ownerId,
}: {
  fromId: number;
  type: AssociationType;
  label: React.ReactNode;
  ownerId: number;
}) {
  const currentUser = useCurrentUser();
  const isOwnerOrModerator = currentUser?.isModerator || currentUser?.id === ownerId;

  const { recommendedResources, isLoading } = useQueryRecommendedResources({
    fromId,
    type,
  });

  const handleManageClick = () => {
    openAssociateModelsModal({ props: { fromId, type } });
  };

  if (!isOwnerOrModerator && !recommendedResources.length) return null;

  return (
    <MasonryProvider maxColumnCount={4}>
      <MasonryContainer>
        <Stack className="py-5">
          <Group>
            <Title order={2}>{label}</Title>
            {isOwnerOrModerator && (
              <Button size="xs" variant="outline" onClick={handleManageClick}>
                Manage {type} Resources
              </Button>
            )}
          </Group>
          {isLoading ? (
            <div style={{ position: 'relative', height: 310 }}>
              <LoadingOverlay visible />
            </div>
          ) : recommendedResources.length ? (
            <MasonryCarousel
              itemWrapperProps={{ style: { paddingTop: 4, paddingBottom: 4 } }}
              data={recommendedResources}
              render={({ data, ...props }) =>
                data.resourceType === 'model' ? (
                  <ModelCard
                    {...props}
                    data={data}
                    data-activity="follow-suggestion:model"
                    forceInView
                  />
                ) : (
                  <ArticleCard {...props} data={data} data-activity="follow-suggestion:article" />
                )
              }
              itemId={(x) => x.id}
            />
          ) : (
            <Group gap="xs" mt="xs">
              <ThemeIcon color="gray" size="xl" radius="xl">
                <IconRocketOff />
              </ThemeIcon>
              <Text size="lg" c="dimmed">
                {`You aren't suggesting any other resources yet...`}
              </Text>
            </Group>
          )}
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}
