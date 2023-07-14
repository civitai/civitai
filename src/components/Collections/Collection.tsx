import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { constants } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';
import {
  ActionIcon,
  Card,
  Container,
  Drawer,
  Grid,
  Navbar,
  Paper,
  Title,
  createStyles,
  Skeleton,
  Group,
  Stack,
  ContainerProps,
} from '@mantine/core';

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
          <Group position="apart" align="center">
            <Title order={1} lh={1.2}>
              {collection?.name ?? 'Loading...'}
            </Title>
          </Group>

          <IsClient>
            <ModelsInfinite filters={{ collectionId }} />
          </IsClient>
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}
