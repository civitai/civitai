import {
  Button,
  Group,
  HoverCard,
  LoadingOverlay,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import type { AssociationType } from '~/shared/utils/prisma/enums';
import { IconRocketOff, IconSparkles } from '@tabler/icons-react';
import React from 'react';
import { useQueryRecommendedResources } from '~/components/AssociatedModels/recommender.utils';

import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { ModelCard } from '~/components/Cards/ModelCard';
import { MasonryCarousel } from '~/components/MasonryColumns/MasonryCarousel';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

export function AssociatedModels({
  fromId,
  type,
  label,
  ownerId,
  versionId,
}: {
  fromId: number;
  type: AssociationType;
  label: React.ReactNode;
  ownerId: number;
  versionId?: number;
}) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const isOwnerOrModerator = currentUser?.isModerator || currentUser?.id === ownerId;

  const browsingLevel = useBrowsingLevelDebounced();
  const { data = [], isLoading } = trpc.model.getAssociatedResourcesCardData.useQuery({
    fromId,
    type,
    browsingLevel,
  });
  const { data: recommendedResources, isInitialLoading: loadingRecommended } =
    useQueryRecommendedResources(
      { modelVersionId: versionId as number },
      { enabled: !!versionId && features.recommenders }
    );

  const combinedData = [...data, ...recommendedResources];

  const handleManageClick = () => {
    openContext('associateModels', { fromId, type, versionId });
  };

  if (!isOwnerOrModerator && !combinedData.length) return null;

  return (
    <MasonryProvider maxColumnCount={4}>
      <MasonryContainer
        my="xl"
        pt="xl"
        pb="xl"
        sx={(theme) => ({
          background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1],
        })}
      >
        {({ columnCount }) => (
          <Stack pb={columnCount > 1 && data.length ? 20 : undefined}>
            <Group>
              <Title order={2}>{label}</Title>
              {isOwnerOrModerator && (
                <Button size="xs" variant="outline" onClick={handleManageClick}>
                  Manage {type} Resources
                </Button>
              )}
            </Group>
            {isLoading || loadingRecommended ? (
              <div style={{ position: 'relative', height: 310 }}>
                <LoadingOverlay visible />
              </div>
            ) : combinedData.length ? (
              <MasonryCarousel
                itemWrapperProps={{ style: { paddingTop: 4, paddingBottom: 4 } }}
                data={combinedData}
                viewportClassName="py-4"
                render={({ data, ...props }) =>
                  data.resourceType === 'model' ? (
                    <ModelCard
                      {...props}
                      data={data}
                      data-activity="follow-suggestion:model"
                      forceInView
                    />
                  ) : data.resourceType === 'recommended' ? (
                    <div style={{ position: 'relative' }}>
                      <AIRecommendedIndicator />
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
              <Group spacing="xs" mt="xs">
                <ThemeIcon color="gray" size="xl" radius="xl">
                  <IconRocketOff />
                </ThemeIcon>
                <Text size="lg" color="dimmed">
                  {`You aren't suggesting any other resources yet...`}
                </Text>
              </Group>
            )}
          </Stack>
        )}
      </MasonryContainer>
    </MasonryProvider>
  );
}

function AIRecommendedIndicator() {
  return (
    <HoverCard width={300} withArrow withinPortal>
      <HoverCard.Target>
        <ThemeIcon
          gradient={{ from: '#4776E6', to: '#8E54E9', deg: 90 }}
          variant="gradient"
          radius="xl"
          size="md"
          className="absolute -right-2 -top-2 z-10"
        >
          <IconSparkles size={16} stroke={1.5} fill="currentColor" />
        </ThemeIcon>
      </HoverCard.Target>
      <HoverCard.Dropdown px="md" py={8}>
        <Text size="sm" weight={600} color="white">
          AI Recommended
        </Text>
        <Text size="xs">This resource has been recommended by Civitai AI</Text>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
