import { Alert, Center, Loader, Stack, Text, Anchor } from '@mantine/core';
import { IconInbox } from '@tabler/icons-react';
import { useMemo } from 'react';
import { GeneratedImage } from '~/components/ImageGeneration/GeneratedImage';
import {
  matchesMarkerTags,
  useGetTextToImageRequestsImages,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { generationGraphPanel } from '~/store/generation-graph.store';

import classes from './Feed.module.scss';

export function Feed() {
  const filters = useFiltersContext((state) => state.generation);

  const { requests, markerTags, isLoading, fetchNextPage, hasNextPage, isRefetching, isError } =
    useGetTextToImageRequestsImages();

  const images = useMemo(
    () =>
      requests.flatMap((r) =>
        r.succeededImages.filter((img) => matchesMarkerTags(img, markerTags))
      ),
    [requests, markerTags]
  );

  if (isError)
    return (
      <Alert color="red">
        <Text align="center">Could not retrieve images</Text>
      </Alert>
    );

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );

  if (!images.length)
    return (
      <Center h="100%">
        <Stack gap="xs" align="center" py="16">
          <IconInbox size={64} stroke={1} />
          {filters.marker && (
            <Stack gap={0}>
              <Text fz={32} align="center">
                No results found
              </Text>
              <Text align="center">{'Try adjusting your filters'}</Text>
            </Stack>
          )}
          {!filters.marker && (
            <Stack gap={0}>
              <Text size="md" align="center">
                The queue is empty
              </Text>
              <Text size="sm" c="dimmed">
                Try{' '}
                <Text
                  c="blue.4"
                  onClick={() => generationGraphPanel.setView('generate')}
                  style={{ cursor: 'pointer' }}
                  span
                >
                  generating
                </Text>{' '}
                new images with our resources
              </Text>
              <Text size="sm" c="dimmed">
                Some new filtering options don&rsquo;t apply retroactively.
              </Text>
            </Stack>
          )}
        </Stack>
      </Center>
    );

  return (
    <div className="flex flex-col gap-2 px-3">
      {/* <GeneratedImagesBuzzPrompt /> */}
      <div className={classes.grid} data-testid="generation-feed-list">
        {images.map((image) => (
          <GeneratedImage key={`${image.workflow.id}_${image.id}`} image={image} />
        ))}
      </div>

      {hasNextPage && (
        <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching}>
          <Center style={{ height: 60 }}>
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </div>
  );
}
