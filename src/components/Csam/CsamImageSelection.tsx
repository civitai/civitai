import {
  Center,
  Loader,
  Checkbox,
  Card,
  Group,
  useMantineTheme,
  Badge,
  Title,
  Button,
} from '@mantine/core';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCallback } from 'react';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import type { ModerationImageModel } from '~/server/services/image.service';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useInView } from '~/hooks/useInView';
import { useCsamImageSelectStore } from '~/components/Csam/useCsamImageSelect.store';
import { useCsamContext } from '~/components/Csam/CsamProvider';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';

import { trpc } from '~/utils/trpc';

export function CsamImageSelection({
  onNext,
  onMissing,
}: {
  onNext: () => void;
  onMissing: () => void;
}) {
  const { userId, user } = useCsamContext();

  const { data: images, isLoading } = trpc.image.getImagesByUserIdForModeration.useQuery({
    userId,
  });

  const hasSelected = useCsamImageSelectStore(
    useCallback(({ selected }) => !!Object.keys(selected[userId] ?? {}).length, [userId])
  );

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (!images?.length)
    return (
      <div className="flex flex-col items-center">
        <NoContent p="xl" message="No images found for this user" />
        <Button onClick={onMissing}>Next user</Button>
      </div>
    );

  return (
    <div className="relative">
      <MasonryProvider
        maxColumnCount={7}
        maxSingleColumnWidth={450}
        style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}
      >
        <div className="pb-3">
          <Title align="center" mb="md">
            CSAM Image Selection
          </Title>
          <IsClient>
            <MasonryContainer>
              <MasonryColumns
                data={images}
                imageDimensions={(data) => {
                  const width = data?.width ?? 450;
                  const height = data?.height ?? 450;
                  return { width, height };
                }}
                maxItemHeight={600}
                render={CsamImageCard}
                itemId={(data) => data.id}
              />
              {/* {hasNextPage && (
              <InViewLoader
                loadFn={fetchNextPage}
                loadCondition={!isRefetching}
                style={{ gridColumn: '1/-1' }}
              >
                <Center p="xl" sx={{ height: 36 }} mt="md">
                  <Loader />
                </Center>
              </InViewLoader>
            )} */}
            </MasonryContainer>
          </IsClient>
        </div>
      </MasonryProvider>
      <Card className="sticky inset-x-0 bottom-0 z-30 rounded-none">
        <Group position="right">
          {/* <Button variant="default">Cancel</Button> */}
          <Badge>
            Selected: <SelectedCount />
          </Badge>
          <Button disabled={!hasSelected} onClick={onNext}>
            Next
          </Button>
        </Group>
      </Card>
    </div>
  );
}

function SelectedCount() {
  const { userId } = useCsamContext();
  const count = useCsamImageSelectStore(
    useCallback(({ selected }) => Object.keys(selected[userId] ?? {}).length, [userId])
  );
  return <>{count.toString()}</>;
}

function CsamImageCard({ data: image, height }: { data: ModerationImageModel; height: number }) {
  const { ref, inView } = useInView();
  const theme = useMantineTheme();
  const userId = image.userId;
  const imageId = image.id;
  const checked = useCsamImageSelectStore((state) => state.selected[userId]?.[imageId] ?? false);
  const toggleSelected = () => useCsamImageSelectStore.getState().toggle(userId, imageId);
  return (
    <MasonryCard
      withBorder
      shadow="sm"
      height={height}
      ref={ref}
      style={{
        outline: checked
          ? `3px solid ${theme.colors[theme.primaryColor][theme.fn.primaryShade()]}`
          : undefined,
      }}
    >
      {inView && (
        <>
          <EdgeMedia
            src={image.url}
            name={image.name ?? image.id.toString()}
            alt={image.name ?? undefined}
            type={image.type}
            width={450}
            placeholder="empty"
            style={{ width: '100%' }}
            onClick={toggleSelected}
          />
          <Checkbox
            checked={checked}
            onChange={toggleSelected}
            size="lg"
            sx={{
              position: 'absolute',
              top: 5,
              right: 5,
              zIndex: 9,
            }}
          />
        </>
      )}
    </MasonryCard>
  );
}
