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
  ActionIcon,
  Modal,
} from '@mantine/core';
import { IconMaximize } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CsamHeldMedia, useHeldGridReport } from '~/components/Csam/CsamHeldMedia';
import { recordShown } from '~/components/Csam/csam-shown';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import type { ModerationImageModel } from '~/server/services/image.service';
import type { ShownRendition } from '@civitai/shared/held-media';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { useInView } from '~/hooks/useInView';
import { useCsamImageSelectStore } from '~/components/Csam/useCsamImageSelect.store';
import { splitLinkedImages } from '~/components/Csam/csam-linked-image-ids';
import { useCsamContext } from '~/components/Csam/CsamProvider';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';

import { trpc } from '~/utils/trpc';

export function CsamImageSelection({
  onNext,
  onMissing,
  imageIds,
}: {
  onNext: () => void;
  onMissing: () => void;
  /** Images the link named: pinned above the grid and preselected. */
  imageIds: number[];
}) {
  const { userId } = useCsamContext();

  const {
    data: images,
    isLoading,
    isError,
    refetch,
  } = trpc.image.getImagesByUserIdForModeration.useQuery({ userId });

  const { linkedImages, missingImageIds, gridImages } = useMemo(
    () => splitLinkedImages(images ?? [], imageIds),
    [images, imageIds]
  );

  useEffect(() => {
    const store = useCsamImageSelectStore.getState();
    for (const image of linkedImages) store.seedSelected(userId, image.id);
  }, [linkedImages, userId]);

  useHeldGridReport(userId, images?.length ?? 0);

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
      <div className="p-xl mx-auto flex max-w-md flex-col items-center gap-3">
        <Alert color="red" title="Could not load this user's media">
          <Text size="xs">
            The request failed, so we can&apos;t tell what this user has. Retry before concluding
            anything is missing.
          </Text>
        </Alert>
        <Button onClick={() => refetch()}>Retry</Button>
      </div>
    );

  const missingLinkedImages = missingImageIds.length > 0;

  if (!images?.length)
    return (
      <div className="flex flex-col items-center gap-3">
        {missingLinkedImages && <MissingImageAlert imageIds={missingImageIds} />}
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
          {missingLinkedImages && (
            <MasonryContainer mb="md">
              <MissingImageAlert imageIds={missingImageIds} />
            </MasonryContainer>
          )}
          {linkedImages.length > 0 && (
            <MasonryContainer mb="md">
              <Alert
                color="blue"
                title={
                  linkedImages.length === 1
                    ? `Reported media (#${linkedImages[0].id})`
                    : `Linked media (${linkedImages.length})`
                }
              >
                <Text size="xs" mb="xs">
                  Linked from the report and selected for you. The rest of this user&apos;s media is
                  below.
                </Text>
                <div className="flex flex-wrap items-start gap-3">
                  {linkedImages.map((image) => (
                    <div key={image.id} style={{ width: 450, maxWidth: '100%' }}>
                      <CsamImageCard data={image} height={pinnedCardHeight(image)} />
                    </div>
                  ))}
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

function MissingImageAlert({ imageIds }: { imageIds: number[] }) {
  const title =
    imageIds.length === 1
      ? `Media #${imageIds[0]} is no longer on this user`
      : `${imageIds.length} linked media are no longer on this user: ${imageIds
          .map((id) => `#${id}`)
          .join(', ')}`;
  return (
    <Alert color="red" title={title}>
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

export function CsamImageCard({
  data: image,
  height,
}: {
  data: ModerationImageModel;
  height: number;
}) {
  const { ref, inView } = useInView();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const userId = image.userId;
  const imageId = image.id;
  const checked = useCsamImageSelectStore((state) => state.selected[userId]?.[imageId] ?? false);
  const preselected = useCsamImageSelectStore((state) => !!state.seeded[`${userId}:${imageId}`]);
  const shownRow = useCsamImageSelectStore((state) => state.shownRows[`${userId}:${imageId}`]);
  const record = (action: 'open' | 'select', rendition: ShownRendition) =>
    void recordShown({ imageId, userId, action, rendition }).then((ok) =>
      useCsamImageSelectStore.getState().setShownRow(userId, imageId, ok ? 'recorded' : 'refused')
    );
  // What the tile has put on screen so far; a selection made before then is not recorded.
  const shown = useRef<ShownRendition | null>(null);
  const [fullView, setFullView] = useState(false);
  const toggleSelected = () => {
    const store = useCsamImageSelectStore.getState();
    const selecting = !store.selected[userId]?.[imageId];
    store.toggle(userId, imageId);
    if (selecting && shown.current) record('select', shown.current);
  };
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
          <CsamHeldMedia
            image={image}
            onClick={toggleSelected}
            onShown={(rendition) => (shown.current = rendition)}
          />
          <ActionIcon
            variant="filled"
            color="dark"
            aria-label="View full size"
            onClick={() => setFullView(true)}
            style={{ position: 'absolute', top: 5, left: 5, zIndex: 9 }}
          >
            <IconMaximize size={16} />
          </ActionIcon>
          {checked && shownRow !== 'recorded' && (preselected || shownRow === 'refused') && (
            <Button
              size="compact-xs"
              color="dark"
              onClick={() => setFullView(true)}
              style={{ position: 'absolute', bottom: 5, left: 5, zIndex: 9 }}
            >
              Open full view to confirm viewed
            </Button>
          )}
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
      <Modal
        opened={fullView}
        onClose={() => setFullView(false)}
        size="xl"
        title={`Media #${imageId}`}
        closeButtonProps={{ 'aria-label': 'Close' }}
      >
        <CsamHeldMedia
          image={image}
          onClick={() => undefined}
          onShown={(rendition) => record('open', rendition)}
        />
      </Modal>
    </MasonryCard>
  );
}
