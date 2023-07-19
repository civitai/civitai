import {
  ActionIcon,
  ContainerProps,
  Group,
  Stack,
  Title,
  Popover,
  Text,
  Button,
} from '@mantine/core';
import { IconDotsVertical, IconInfoCircle, IconPlus } from '@tabler/icons-react';
import { ComingSoon } from '~/components/ComingSoon/ComingSoon';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { constants } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';

export function Collection({
  collectionId,
  ...containerProps
}: { collectionId: number } & Omit<ContainerProps, 'children'>) {
  const { data: { collection, permissions } = {}, isLoading } = trpc.collection.getById.useQuery({
    id: collectionId,
  });

  console.log(permissions);

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
            <ComingSoon
              message={`We're still working on adding the ability to follow collections. Check back soon!`}
            >
              <Button variant="outline" size="xs" pl={4} pr={8} ml="auto">
                <Group spacing={4}>
                  <IconPlus size={18} />
                  Follow
                </Group>
              </Button>
            </ComingSoon>
            <ComingSoon
              message={`We're still working on adding the ability to edit and delete your collections, but thought we'd get this into your hands anyway. Check back soon!`}
            >
              <ActionIcon variant="outline">
                <IconDotsVertical size={16} />
              </ActionIcon>
            </ComingSoon>
          </Group>

          <IsClient>
            <ModelsInfinite filters={{ collectionId, period: 'AllTime' }} />
          </IsClient>
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}
