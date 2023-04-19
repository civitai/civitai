import { useRouter } from 'next/router';
import { useCurrentUser } from '~/hooks/useCurrentUser';

import { NotFound } from '~/components/AppLayout/NotFound';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { constants } from '~/server/common/constants';
import { Group, Stack } from '@mantine/core';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { postgresSlugify } from '~/utils/string-helpers';

export default function UserPosts() {
  const filters = usePostQueryParams();
  const currentUser = useCurrentUser();

  if (
    !currentUser ||
    !filters.username ||
    (!currentUser?.isModerator && filters.username !== postgresSlugify(currentUser.username))
  )
    return <NotFound />;

  return (
    <MasonryProvider
      columnWidth={constants.cardSizes.image}
      maxColumnCount={7}
      maxSingleColumnWidth={450}
    >
      <MasonryContainer fluid>
        <Stack spacing="xs">
          <Group position="apart" spacing={0}>
            <SortFilter type="posts" />
            <PeriodFilter type="posts" />
          </Group>
          <PostsInfinite filters={filters} />
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}
