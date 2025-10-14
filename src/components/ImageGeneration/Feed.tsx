import { Alert, Center, Loader, Stack, Text, Anchor } from '@mantine/core';
import { IconInbox } from '@tabler/icons-react';
import { GeneratedImage } from '~/components/ImageGeneration/GeneratedImage';
import { useGetTextToImageRequestsImages } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { generationPanel } from '~/store/generation.store';
import { isDefined } from '~/utils/type-guards';
import classes from './Feed.module.scss';

const cutoff = new Date('10/13/2025').getTime();
export function Feed() {
  const filters = useFiltersContext((state) => state.generation);

  const { requests, steps, isLoading, fetchNextPage, hasNextPage, isRefetching, isError } =
    useGetTextToImageRequestsImages();

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

  if (!steps.flatMap((x) => x.images).length)
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
                  onClick={() => generationPanel.setView('generate')}
                  style={{ cursor: 'pointer' }}
                  span
                >
                  generating
                </Text>{' '}
                new images with our resources
              </Text>
              <Text size="sm" c="dimmed">
                Images generated prior to 10/13/2025 are now visible on{' '}
                <Anchor href="https://civitai.com/generate">civitai.com</Anchor>
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
        {steps.map((step) =>
          step.images
            .filter((x) => x.status === 'succeeded')
            .map((image) => {
              if (image.status !== 'succeeded') return null;

              const request = requests.find((request) => request.id === image.workflowId);
              if (!request) return null;

              return (
                <GeneratedImage
                  key={`${image.workflowId}_${image.id}`}
                  request={request}
                  step={step}
                  image={image}
                />
              );
            })
            .filter(isDefined)
        )}
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
