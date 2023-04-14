import { useRouter } from 'next/router';

import { Group, Stack } from '@mantine/core';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NotFound } from '~/components/AppLayout/NotFound';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { constants } from '~/server/common/constants';

export default function UserImages() {
  const router = useRouter();
  const { username } = userPageQuerySchema.parse(router.query);
  const currentUser = useCurrentUser();

  // currently not showing any content if the username is undefined
  if (!username || (!currentUser?.isModerator && username !== currentUser?.username))
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
            <SortFilter type="image" />
            <PeriodFilter />
          </Group>
          {/* <ImageCategories /> */}
          <ImagesInfinite filters={{ username }} withTags />
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}
