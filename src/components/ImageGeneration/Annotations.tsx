import { Center, Loader, createStyles, Stack, Alert, Text } from '@mantine/core';
import { IconInbox } from '@tabler/icons-react';
import { GeneratedImage } from '~/components/ImageGeneration/GeneratedImage';
import { useGetTextToImageRequestsImages } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { generationPanel } from '~/store/generation.store';
import { isDefined } from '~/utils/type-guards';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';

export function Annotations() {
  const { classes } = useStyles();
  const { requests, steps, isLoading, fetchNextPage, hasNextPage, isRefetching, isError } =
    useGetTextToImageRequestsImages();

  console.log('Annotations from useGetTextToImageRequestsImages', { requests, steps, isLoading, fetchNextPage, hasNextPage, isRefetching, isError });

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
        </Stack>
      </Center>
    );

  return (
    <ScrollArea scrollRestore={{ key: 'feed' }} className="flex flex-col gap-2 px-3">
      {/* <GeneratedImagesBuzzPrompt /> */}
      <div className={classes.grid}>
        {steps.map((step) =>
          step.images
            .map((image) => {
              if (image.status !== 'succeeded') return null;

              if (typeof step.metadata.images === 'undefined') return null;

              if (image.id in step.metadata.images) {
                const imageAnnotations = step.metadata.images[image.id];
                const { feedback } = imageAnnotations;

                if (feedback !== 'liked') return null;
              }

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
    </ScrollArea>
  );
}

const useStyles = createStyles((theme) => ({
  grid: {
    display: 'grid',
    gridTemplateRows: 'masonry',
    gap: theme.spacing.xs,
    gridTemplateColumns: '1fr 1fr',

    [`@container (min-width: 530px)`]: {
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
