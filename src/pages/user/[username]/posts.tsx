import { Group, Stack } from '@mantine/core';

import { NotFound } from '~/components/AppLayout/NotFound';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { UserProfileLayout } from '~/pages/user/[username]';
import { constants } from '~/server/common/constants';
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

UserPosts.getLayout = UserProfileLayout;
