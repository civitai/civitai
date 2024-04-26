import {
  Center,
  Loader,
  Checkbox,
  Card,
  Group,
  useMantineTheme,
  Badge,
  Title,
} from '@mantine/core';
import { useQueryImages } from '~/components/Image/image.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NoContent } from '~/components/NoContent/NoContent';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { useCallback } from 'react';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useInView } from '~/hooks/useInView';
import { useCsamImageSelectStore } from '~/components/Csam/useCsamImageSelect.store';
import { useCsamContext } from '~/components/Csam/CsamProvider';
import { Stepper } from '~/components/Stepper/Stepper';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { ImageSort } from '~/server/common/enums';

export function CsamImageSelection() {
  const { userId, user } = useCsamContext();

  // TODO - get all images for user, don't use this util unless we provide a way to get all images regardless of ingestion status
  const {
    flatData: images,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isRefetching,
  } = useQueryImages(
    { username: user?.username ?? undefined, sort: ImageSort.Newest, include: [] },
    { applyHiddenPreferences: false, enabled: !!user }
  );

  const hasSelected = useCsamImageSelectStore(
    useCallback(({ selected }) => !!Object.keys(selected[userId] ?? {}).length, [userId])
  );

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (!images?.length) return <NoContent p="xl" message="No images found for this user" />;

  return (
    <MasonryProvider
      columnWidth={300}
      maxColumnCount={7}
      maxSingleColumnWidth={450}
      style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <ScrollArea>
        <Title align="center" mb="md">
          CSAM Image Selection
        </Title>
        <IsClient>
          <MasonryContainer>
            <ImagesProvider images={images}>
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
            </ImagesProvider>
            {hasNextPage && (
              <InViewLoader
                loadFn={fetchNextPage}
                loadCondition={!isRefetching}
                style={{ gridColumn: '1/-1' }}
              >
                <Center p="xl" sx={{ height: 36 }} mt="md">
                  <Loader />
                </Center>
              </InViewLoader>
            )}
          </MasonryContainer>
        </IsClient>
      </ScrollArea>
      <Card p="xs" style={{ zIndex: 30 }}>
        <MasonryContainer>
          <Group position="right">
            {/* <Button variant="default">Cancel</Button> */}
            <Badge>
              Selected: <SelectedCount />
            </Badge>
            <Stepper.NextButton disabled={!hasSelected}>Next</Stepper.NextButton>
          </Group>
        </MasonryContainer>
      </Card>
    </MasonryProvider>
  );
}

function SelectedCount() {
  const { userId } = useCsamContext();
  const count = useCsamImageSelectStore(
    useCallback(({ selected }) => Object.keys(selected[userId] ?? {}).length, [userId])
  );
  return <>{count.toString()}</>;
}

function CsamImageCard({ data: image, height }: { data: ImagesInfiniteModel; height: number }) {
  const { ref, inView } = useInView({ rootMargin: '600px' });
  const theme = useMantineTheme();
  const userId = image.user.id;
  const imageId = image.id;
  const checked = useCsamImageSelectStore((state) => state.selected[userId]?.[imageId] ?? false);
  const toggleSelected = () => useCsamImageSelectStore.getState().toggle(userId, imageId);
  return (
    <MasonryCard
      withBorder
      shadow="sm"
      p={0}
      height={height}
      ref={ref}
      sx={{ position: 'relative' }}
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
