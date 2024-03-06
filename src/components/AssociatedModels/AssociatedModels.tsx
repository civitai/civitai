import { Button, Group, LoadingOverlay, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import type { AssociationType } from '@prisma/client';
import { IconRocketOff } from '@tabler/icons-react';
import React from 'react';

import { ArticleAltCard } from '~/components/Article/Infinite/ArticleAltCard';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { MasonryCarousel } from '~/components/MasonryColumns/MasonryCarousel';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelCategoryCard } from '~/components/Model/Categories/ModelCategoryCard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { trpc } from '~/utils/trpc';

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

  const browsingLevel = useBrowsingLevelDebounced();
  const { data = [], isLoading } = trpc.model.getAssociatedResourcesCardData.useQuery({
    fromId,
    type,
    browsingLevel,
  });

  const handleManageClick = () => {
    openContext('associateModels', { fromId, type });
  };

  if (!isOwnerOrModerator && !data.length) return null;

  return (
    <MasonryProvider columnWidth={310} maxColumnCount={4} maxSingleColumnWidth={450}>
      <MasonryContainer
        my="xl"
        pt="xl"
        pb="xl"
        sx={(theme) => ({
          background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1],
        })}
      >
        {({ columnWidth, columnCount }) => (
          <Stack pb={columnCount > 1 && data.length ? 20 : undefined}>
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
            ) : data.length ? (
              <MasonryCarousel
                data={data}
                render={({ data, ...props }) =>
                  data.resourceType === 'model' ? (
                    <ModelCategoryCard
                      data={data}
                      {...props}
                      data-activity="follow-suggestion:model"
                    />
                  ) : (
                    <ArticleAltCard
                      data={data}
                      {...props}
                      data-activity="follow-suggestion:article"
                    />
                  )
                }
                height={columnWidth}
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
