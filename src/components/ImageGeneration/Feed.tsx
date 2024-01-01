import { Center, Loader, createStyles, Stack } from '@mantine/core';
import { GeneratedImage } from '~/components/ImageGeneration/GeneratedImage';
import { useGetGenerationRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { isDefined } from '~/utils/type-guards';

export function Feed({
  requests,
  images: feed,
  fetchNextPage,
  hasNextPage,
  isRefetching,
  isFetchingNextPage,
}: ReturnType<typeof useGetGenerationRequests>) {
  const { classes } = useStyles();

  return (
    <Stack
      spacing="xs"
      sx={{ position: 'relative', flex: 1, overflow: 'hidden', containerType: 'inline-size' }}
    >
      <div className={classes.grid}>
        {feed
          .map((image) => {
            const request = requests.find((request) =>
              request.images?.some((x) => x.id === image.id)
            );
            if (!request) return null;

            return <GeneratedImage key={image.id} request={request} image={image} />;
          })
          .filter(isDefined)}
      </div>
      {hasNextPage && (
        <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching && !isFetchingNextPage}>
          <Center sx={{ height: 60 }}>
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </Stack>
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
