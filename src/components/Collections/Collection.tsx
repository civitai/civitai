import { ActionIcon, ContainerProps, Group, Stack, Title, Popover, Text } from '@mantine/core';
import { IconDotsVertical, IconInfoCircle, IconMessage2 } from '@tabler/icons-react';
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
  const { data: collection, isLoading } = trpc.collection.getById.useQuery({ id: collectionId });

  return (
    <MasonryProvider
      columnWidth={constants.cardSizes.model}
      maxColumnCount={7}
      maxSingleColumnWidth={450}
    >
      <MasonryContainer {...containerProps}>
        <Stack spacing="xs">
          <Group align="center" spacing="xs">
            <Title order={1} lh={1.2}>
              {collection?.name ?? 'Loading...'}
            </Title>
            {collection?.description && (
              <Popover withArrow>
                <Popover.Target>
                  <ActionIcon color="gray" variant="transparent" radius="xl" size="lg" ml="auto">
                    <IconInfoCircle size={28} strokeWidth={2} />
                  </ActionIcon>
                </Popover.Target>
                <Popover.Dropdown>
                  <Text size="sm">{collection.description}</Text>
                </Popover.Dropdown>
              </Popover>
            )}
            <ComingSoon
              message={`We're still working on adding the ability to edit and delete your collections, but thought we'd get this into your hands anyway. Check back soon!`}
            >
              <ActionIcon variant="outline">
                <IconDotsVertical size={16} />
              </ActionIcon>
            </ComingSoon>
          </Group>

          <IsClient>
            <ModelsInfinite filters={{ collectionId }} />
          </IsClient>
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}
