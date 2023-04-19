import { Group, Stack } from '@mantine/core';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { UserProfileLayout } from '~/pages/user/[username]';
import { constants } from '~/server/common/constants';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { postgresSlugify } from '~/utils/string-helpers';

export default function UserImages() {
  const router = useRouter();
  const { username } = userPageQuerySchema.parse(router.query);
  const currentUser = useCurrentUser();

  // currently not showing any content if the username is undefined
  if (
    !currentUser ||
    !username ||
    (!currentUser.isModerator && username !== postgresSlugify(currentUser.username))
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
            <SortFilter type="images" />
            <PeriodFilter type="images" />
          </Group>
          {/* <ImageCategories /> */}
          <ImagesInfinite filters={{ username }} withTags />
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}

UserImages.getLayout = UserProfileLayout;
