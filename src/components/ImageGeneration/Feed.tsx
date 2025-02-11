import { Alert, Center, createStyles, Loader, Stack, Text } from '@mantine/core';
import { IconInbox } from '@tabler/icons-react';
import { GeneratedImage } from '~/components/ImageGeneration/GeneratedImage';
import { useGetTextToImageRequestsImages } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { generationPanel } from '~/store/generation.store';
import { isDefined } from '~/utils/type-guards';

export function Feed() {
  const { classes } = useStyles();

  const filters = useFiltersContext((state) => state.markers);

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
        <Stack spacing="xs" align="center" py="16">
          <IconInbox size={64} stroke={1} />
          {filters.marker && (
            <Stack spacing={0}>
              <Text size={32} align="center">
                No results found
              </Text>
              <Text align="center">{'Try adjusting your filters'}</Text>
            </Stack>
          )}
          {!filters.marker && (
            <Stack spacing={0}>
              <Text size="md" align="center">
                The queue is empty
              </Text>
              <Text size="sm" color="dimmed">
                Try{' '}
                <Text
                  variant="link"
                  onClick={() => generationPanel.setView('generate')}
                  sx={{ cursor: 'pointer' }}
                  span
                >
                  generating
                </Text>{' '}
                new images with our resources
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
          <Center sx={{ height: 60 }}>
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </div>
  );
}

const useStyles = createStyles((theme) => ({
  grid: {
    display: 'grid',
    gridTemplateRows: 'masonry',
    gap: theme.spacing.xs,
    gridTemplateColumns: '1fr',

    [`@container (min-width: 290px)`]: {
      gridTemplateColumns: 'repeat(2, 1fr)',
    },
    [`@container (min-width: 650px)`]: {
      gridTemplateColumns: 'repeat(3, 1fr)',
    },
    [`@container (min-width: 900px)`]: {
      gridTemplateColumns: 'repeat(4, 1fr)',
    },
    [`@container (min-width: 1200px)`]: {
      gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))',
    },
  },
}));
