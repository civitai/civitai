import { Button, Group, LoadingOverlay, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconRocketOff } from '@tabler/icons-react';

import { ModelCard } from '~/components/Cards/ModelCard';
import { MasonryCarousel } from '~/components/MasonryColumns/MasonryCarousel';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openRoutedContext } from '~/providers/RoutedContextProvider';
import { trpc } from '~/utils/trpc';
import { ModelCardContextProvider } from '~/components/Cards/ModelCardContext';

type Props = { sourceId: number; label: string; ownerId: number };

export function RecommendedResources({ sourceId, label, ownerId }: Props) {
  const currentUser = useCurrentUser();
  const isOwnerOrModerator = currentUser?.isModerator || currentUser?.id === ownerId;

  const { data = [], isLoading } = trpc.model.getRecommendedResourcesCardData.useQuery({
    sourceId,
  });

  if (!isOwnerOrModerator && !data.length) return null;

  return (
    <MasonryProvider columnWidth={310} maxColumnCount={4} maxSingleColumnWidth={450}>
      <MasonryContainer
        fluid
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
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    openRoutedContext('modelVersionEdit', { modelVersionId: sourceId })
                  }
                >
                  Manage Recommended Resources
                </Button>
              )}
            </Group>
            {isLoading ? (
              <div style={{ position: 'relative', height: 310 }}>
                <LoadingOverlay visible />
              </div>
            ) : data.length ? (
              <ModelCardContextProvider useModelVersionRedirect>
                <MasonryCarousel
                  data={data}
                  render={ModelCard}
                  height={columnWidth}
                  itemId={(x) => x.id}
                  itemWrapperProps={{ style: { position: 'relative' } }}
                />
              </ModelCardContextProvider>
            ) : (
              <Group spacing="xs" mt="xs">
                <ThemeIcon color="gray" size="xl" radius="xl">
                  <IconRocketOff />
                </ThemeIcon>
                <Text size="lg" color="dimmed">
                  {`You aren't recommending any other resources yet...`}
                </Text>
              </Group>
            )}
          </Stack>
        )}
      </MasonryContainer>
    </MasonryProvider>
  );
}
