import { ActionIcon, ContainerProps, Group, Stack, Title, Text } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import { ComingSoon } from '~/components/ComingSoon/ComingSoon';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { constants } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';
import { CollectionFollowAction } from '~/components/Collections/components/CollectionFollow';

export function Collection({
  collectionId,
  ...containerProps
}: { collectionId: number } & Omit<ContainerProps, 'children'>) {
  const { data: { collection, permissions } = {} } = trpc.collection.getById.useQuery({
    id: collectionId,
  });

  return (
    <MasonryProvider
      columnWidth={constants.cardSizes.model}
      maxColumnCount={7}
      maxSingleColumnWidth={450}
    >
      <MasonryContainer {...containerProps}>
        <Stack spacing="xs" w="100%">
          <Group align="center" spacing="xs" noWrap style={{ alignItems: 'flex-start' }}>
            <Stack spacing={0}>
              <Title order={1} lh={1}>
                {collection?.name ?? 'Loading...'}
              </Title>
              {collection?.description && (
                <Text size="xs" color="dimmed">
                  {collection.description}
                </Text>
              )}
            </Stack>
            {collection && permissions && (
              <Group ml="auto">
                <CollectionFollowAction collection={collection} permissions={permissions} />
                <ComingSoon
                  message={`We're still working on adding the ability to edit and delete your collections, but thought we'd get this into your hands anyway. Check back soon!`}
                >
                  <ActionIcon variant="outline">
                    <IconDotsVertical size={16} />
                  </ActionIcon>
                </ComingSoon>
              </Group>
            )}
          </Group>

          <IsClient>
            <ModelsInfinite filters={{ collectionId, period: 'AllTime' }} />
          </IsClient>
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}
