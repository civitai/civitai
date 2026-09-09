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
  getPrimaryShade,
  useComputedColorScheme,
  Alert,
  Text,
} from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCallback, useEffect, useMemo } from 'react';
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
  imageId,
}: {
  onNext: () => void;
  onMissing: () => void;
  imageId?: number;
}) {
  const { userId } = useCsamContext();

  const {
    data: images,
    isLoading,
    isError,
    refetch,
  } = trpc.image.getImagesByUserIdForModeration.useQuery({ userId });

  const linkedImage = useMemo(
    () => (imageId ? images?.find((x) => x.id === imageId) : undefined),
    [images, imageId]
  );
  const gridImages = useMemo(
    () => (linkedImage ? images?.filter((x) => x.id !== linkedImage.id) : images),
    [images, linkedImage]
  );

  useEffect(() => {
    if (linkedImage) useCsamImageSelectStore.getState().seedSelected(userId, linkedImage.id);
  }, [linkedImage, userId]);

  const hasSelected = useCsamImageSelectStore(
    useCallback(({ selected }) => !!Object.keys(selected[userId] ?? {}).length, [userId])
  );

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );

  // A failed fetch also leaves `images` undefined; without this the empty state below
  // would tell a moderator their evidence was purged when it is merely unloaded.
  if (isError)
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 p-xl">
        <Alert color="red" title="Could not load this user's media">
          <Text size="xs">
            The request failed, so we can&apos;t tell what this user has. Retry before concluding
            anything is missing.
          </Text>
        </Alert>
        <Button onClick={() => refetch()}>Retry</Button>
      </div>
    );

  const missingLinkedImage = !!imageId && !linkedImage;

  if (!images?.length)
    return (
      <div className="flex flex-col items-center gap-3">
        {missingLinkedImage && <MissingImageAlert imageId={imageId} />}
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
          <Title className="text-center" mb="md">
            CSAM Image Selection
          </Title>
          {missingLinkedImage && (
            <MasonryContainer mb="md">
              <MissingImageAlert imageId={imageId} />
            </MasonryContainer>
          )}
          {linkedImage && (
            <MasonryContainer mb="md">
              <Alert color="blue" title={`Reported media (#${linkedImage.id})`}>
                <Text size="xs" mb="xs">
                  Linked from the report and selected for you. The rest of this user&apos;s media is
                  below.
                </Text>
                <div style={{ maxWidth: 450 }}>
                  <CsamImageCard data={linkedImage} height={pinnedCardHeight(linkedImage)} />
                </div>
              </Alert>
            </MasonryContainer>
          )}
          <IsClient>
            <MasonryContainer>
              <MasonryColumns
                data={gridImages ?? []}
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
                <Center p="xl" style={{ height: 36 }} mt="md">
                  <Loader />
                </Center>
              </InViewLoader>
            )} */}
            </MasonryContainer>
          </IsClient>
        </div>
      </MasonryProvider>
      <Card className="sticky inset-x-0 bottom-0 z-30 rounded-none pb-[max(var(--mantine-spacing-md),var(--safe-area-inset-bottom))]">
        <Group justify="flex-end">
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

// MasonryCard clips to its height, and this is the one item the moderator has to be able
// to see whole. Mirrors the grid's 450px column and 600px maxItemHeight.
function pinnedCardHeight({ width, height }: { width: number | null; height: number | null }) {
  if (!width || !height) return 450;
  return Math.min(Math.round((450 * height) / width), 600);
}

function MissingImageAlert({ imageId }: { imageId: number }) {
  return (
    <Alert color="red" title={`Media #${imageId} is no longer on this user`}>
      <Text size="xs">
        It was most likely purged after being blocked, or moved to another account. If you still
        have the file, submit it through the{' '}
        <Text component={Link} c="blue.4" href="/moderator/csam/external" inherit>
          external CSAM report form
        </Text>
        . Note that an external report does not ban or soft-delete the user — do that separately.
      </Text>
    </Alert>
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
  const colorScheme = useComputedColorScheme('dark');
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
          ? `3px solid ${theme.colors[theme.primaryColor][getPrimaryShade(theme, colorScheme)]}`
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
            style={{
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
