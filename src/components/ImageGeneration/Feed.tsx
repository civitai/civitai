import {
  ActionIcon,
  Center,
  Group,
  Loader,
  Text,
  Tooltip,
  createStyles,
  TooltipProps,
  LoadingOverlay,
  Stack,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconCloudUpload, IconSquareOff, IconTrash, IconWindowMaximize } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { GeneratedImage } from '~/components/ImageGeneration/GeneratedImage';
import { generationImageSelect } from '~/components/ImageGeneration/utils/generationImage.select';
import {
  useDeleteGenerationRequestImages,
  useGetGenerationRequests,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { constants } from '~/server/common/constants';
import { Generation } from '~/server/services/generation/generation.types';
import { generationPanel } from '~/store/generation.store';
import { postImageTransmitter } from '~/store/post-image-transmitter.store';
import { trpc } from '~/utils/trpc';
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
      p="md"
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
