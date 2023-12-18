import { Center, Loader, Checkbox, Card, Group, Button } from '@mantine/core';
import { useQueryImages } from '~/components/Image/image.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NoContent } from '~/components/NoContent/NoContent';
import { trpc } from '~/utils/trpc';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { useEffect, useState } from 'react';
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

export function CsamImageSelection({ imageId }: { imageId?: number }) {
  const { userId, isInternal } = useCsamContext();
  const { data: user } = trpc.user.getById.useQuery({ id: userId }, { enabled: !isInternal });
  const { images, isLoading, fetchNextPage, hasNextPage, isRefetching } = useQueryImages(
    { username: user?.username ?? undefined },
    { applyHiddenPreferences: false, enabled: !!user, keepPreviousData: true }
  );

  const [hasSelected, setHasSelected] = useState(!!imageId);

  useEffect(() => {
    if (userId)
      useCsamImageSelectStore.subscribe(({ selected }) => {
        const count = Object.keys(selected[userId] ?? {}).length;
        setHasSelected(!!count);
      });
  }, [userId]);

  // get initial image in select store
  useEffect(() => {
    if (imageId !== undefined)
      useCsamImageSelectStore.getState().toggle(userId ?? -1, imageId, true);
  }, [imageId, userId]);

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (!images.length) return <NoContent message="No images found for this user" />;

  return (
    <MasonryProvider columnWidth={300} maxColumnCount={7} maxSingleColumnWidth={450}>
      <ScrollArea>
        <IsClient>
          <MasonryContainer size="xl" w="100%">
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
        <MasonryContainer size="xl">
          <Group position="right">
            {/* <Button variant="default">Cancel</Button> */}
            <Stepper.NextButton disabled={!hasSelected}>Next</Stepper.NextButton>
          </Group>
        </MasonryContainer>
      </Card>
    </MasonryProvider>
  );
}

function CsamImageCard({ data: image, height }: { data: ImagesInfiniteModel; height: number }) {
  const { ref, inView } = useInView({ rootMargin: '600px' });
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
