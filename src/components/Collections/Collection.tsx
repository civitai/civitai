import { ActionIcon, Button, ContainerProps, Group, Menu, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { CollectionType } from '@prisma/client';
import { IconCloudOff , IconDotsVertical, IconPencil, IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { AddUserContentModal } from '~/components/Collections/AddUserContentModal';
import { ComingSoon } from '~/components/ComingSoon/ComingSoon';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { constants } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';
import { CollectionFollowAction } from '~/components/Collections/components/CollectionFollow';
import { NextLink } from '@mantine/next';

export function Collection({
  collectionId,
  ...containerProps
}: { collectionId: number } & Omit<ContainerProps, 'children'>) {
  const [opened, setOpened] = useState(false);

  const { data: { collection, permissions } = {}, isLoading } = trpc.collection.getById.useQuery({
    id: collectionId,
  });

  if (!isLoading && !collection) {
    return (
      <Stack w="100%" align="center">
        <Stack spacing="md" align="center" maw={800}>
          <Title order={1} lh={1}>
            Whoops!
          </Title>
          <Text align="center">
            It looks like you landed on the wrong place.The collection you are trying to access does
            not exist or you do not have the sufficient permissions to see it.
          </Text>
          <ThemeIcon size={128} radius={100} sx={{ opacity: 0.5 }}>
            <IconCloudOff size={80} />
          </ThemeIcon>
        </Stack>
      </Stack>
    );
  }
  const collectionType = collection.type;

  return (
    <MasonryProvider
      columnWidth={constants.cardSizes.model}
      maxColumnCount={7}
      maxSingleColumnWidth={450}
    >
      <MasonryContainer {...containerProps}>
        <Stack spacing="xs" w="100%">
          <Group align="center" spacing="xs" position="apart" noWrap>
            <Stack spacing={0}>
              <Title order={1} lineClamp={1}>
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
                {permissions.manage && (
                  <Menu>
                    <Menu.Target>
                      <ActionIcon variant="outline">
                        <IconDotsVertical size={16} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      {collectionType === CollectionType.Image && (
                        <Menu.Item
                          icon={<IconPlus size={14} stroke={1.5} />}
                          onClick={() => setOpened(true)}
                        >
                          Add from your library
                        </Menu.Item>
                      )}
                      <Menu.Item
                        component={NextLink}
                        icon={<IconPencil size={14} stroke={1.5} />}
                        href={`/collections/${collection.id}/review`}
                      >
                        Review Items
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                )}
              </Group>
            )}
          </Group>

            <IsClient>
              {collectionType === CollectionType.Model && (
                <ModelsInfinite filters={{ collectionId, period: 'AllTime' }} />
              )}
              {collectionType === CollectionType.Image && (
                <ImagesInfinite filters={{ collectionId, period: 'AllTime' }} />
              )}
            </IsClient>
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
      {collection && collectionType === CollectionType.Image && (
        <AddUserContentModal
          collectionId={collection.id}
          opened={opened}
          onClose={() => setOpened(false)}
        />
      )}
    </>
  );
}
