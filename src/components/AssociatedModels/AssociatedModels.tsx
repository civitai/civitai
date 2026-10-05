import { SponsoredBadge } from '~/components/Promotion/SponsoredBadge';
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
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { trpc } from '~/utils/trpc';

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

  // The card query is filtered by the viewer's settings, so an empty result can't tell
  // "none set" from "all hidden". Same key as the manage modal, so this shares its cache.
  const { data: savedResources, isLoading: loadingSaved } =
    trpc.model.getAssociatedResourcesSimple.useQuery(
      { fromId, type, browsingLevel: allBrowsingLevelsFlag },
      { enabled: isOwnerOrModerator && !isLoading && !recommendedResources.length }
    );
  const allHiddenByFilters = !!savedResources?.length;

  const handleManageClick = () => {
    openAssociateModelsModal({ props: { fromId, type, ownerId } });
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
          {isLoading || loadingSaved ? (
            <div style={{ position: 'relative', height: 310 }}>
              <LoadingOverlay visible />
            </div>
          ) : recommendedResources.length ? (
            <MasonryCarousel
              itemWrapperProps={{ style: { paddingTop: 4, paddingBottom: 4 } }}
              data={recommendedResources}
              render={({ data, ...props }) =>
                data.resourceType === 'model' ? (
                  <div className="relative">
                    {data.sponsored && (
                      <SponsoredBadge
                        kind="model"
                        className="absolute left-1/2 top-2 -translate-x-1/2"
                      />
                    )}
                    <ModelCard
                      {...props}
                      data={data}
                      data-activity="follow-suggestion:model"
                      forceInView
                    />
                  </div>
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
                {allHiddenByFilters
                  ? 'All suggested resources are hidden by your current content filters.'
                  : `You aren't suggesting any other resources yet...`}
              </Text>
            </Group>
          )}
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}
