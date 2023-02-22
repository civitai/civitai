import { ActionIcon, Center, Container, Group, Loader, Stack } from '@mantine/core';
import { IconFilterOff } from '@tabler/icons';
import { useEffect, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';
import { Announcements } from '~/components/Announcements/Announcements';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';

import {
  GalleryCategories,
  GalleryFilters,
  GalleryPeriod,
  GallerySort,
  useGalleryFilters,
} from '~/components/Gallery/GalleryFilters';
import { InfiniteGalleryGrid } from '~/components/Gallery/InfiniteGalleryGrid';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { MasonryGrid } from '~/components/MasonryGrid/MasonryGrid';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { hideMobile, showMobile } from '~/libs/sx-helpers';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerAuthSession(context);
  if (!session?.user?.isModerator || session.user?.bannedAt) {
    return {
      redirect: {
        destination: '/',
        permanent: false,
      },
    };
  }
  return { props: {} };
};

// TODO Manuel
export default function Images() {
  const { ref, inView } = useInView();
  const { data, isLoading } = trpc.image.getGalleryImagesInfinite.useInfiniteQuery(
    {
      inReview: true,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );
  const images = useMemo(
    () => data?.pages.flatMap((x) => (!!x ? x.items : [])) ?? [],
    [data?.pages]
  );

  return (
    <Container>
      {isLoading ? (
        <Center py="xl">
          <Loader size="xl" />
        </Center>
      ) : images.length ? (
        <MasonryGrid items={images} render={ImageGridItem} />
      ) : (
        <NoContent mt="lg" />
      )}
      {!isLoading && hasNextPage && (
        <Group position="center" ref={ref}>
          <Loader />
        </Group>
      )}
    </Container>
  );
}

function ImageGridItem({ data, index }: Props) {
  return (
    <Card>

    </Card>
}

type ImageGridItemProps = {
  data: any;
  index: number;
};
