import React, { useState } from 'react';
import { FeedLayout } from '~/pages/clubs/[id]/index';
import { useRouter } from 'next/router';
import { Group, Stack } from '@mantine/core';
import { constants } from '~/server/common/constants';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { SortFilter } from '~/components/Filters';
import { PostSort } from '~/server/common/enums';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MetricTimeframe } from '@prisma/client';
import { PostsQueryInput } from '../../../server/schema/post.schema';
import { PostFiltersDropdown } from '../../../components/Post/Infinite/PostFiltersDropdown';
import PostsInfinite, { PostsInfiniteState } from '../../../components/Post/Infinite/PostsInfinite';
import { PostCard } from '../../../components/Cards/PostCard';
import { createServerSideProps } from '../../../server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.clubs) return { notFound: true };

    // return {
    //   redirect: {
    //     destination: '/content/clubs',
    //     permanent: false,
    //   },
    // };
  },
});

const ClubImagePosts = () => {
  const router = useRouter();
  const { id: stringId } = router.query as {
    id: string;
  };
  const id = Number(stringId);
  const [filters, setFilters] = useState<Partial<PostsInfiniteState> & { clubId: number }>({
    sort: PostSort.Newest,
    period: MetricTimeframe.AllTime,
    clubId: id,
  });

  return (
    <>
      <Stack mb="sm">
        <Group position="apart" spacing={0}>
          <SortFilter
            type="posts"
            value={filters.sort as PostSort}
            onChange={(x) => setFilters((f) => ({ ...f, sort: x as PostSort }))}
          />
          <Group spacing="xs">
            <PostFiltersDropdown
              query={filters}
              onChange={(updated) => setFilters((f) => ({ ...f, ...updated }))}
            />
          </Group>
        </Group>
      </Stack>
      <MasonryProvider columnWidth={constants.cardSizes.model} maxColumnCount={7}>
        <MasonryContainer mt="md" p={0}>
          <PostsInfinite
            filters={{
              ...filters,
            }}
          />
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
};

ClubImagePosts.getLayout = function getLayout(page: React.ReactNode) {
  return <FeedLayout>{page}</FeedLayout>;
};

export default ClubImagePosts;
