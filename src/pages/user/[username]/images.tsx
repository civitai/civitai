import { useRouter } from 'next/router';

import { Container, Group, Stack } from '@mantine/core';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { ImageCategories } from '~/components/Image/Infinite/ImageCategories';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { BrowsingMode } from '~/server/common/enums';

export default function UserImages() {
  const router = useRouter();
  const username = router.query.username as string;
  const currentUser = useCurrentUser();
  const browsingMode = currentUser?.username === username ? BrowsingMode.All : undefined;

  return (
    <Container fluid style={{ maxWidth: 2500 }}>
      <Stack spacing="xs">
        <Group position="apart" spacing={0}>
          <SortFilter type="image" />
          <PeriodFilter />
        </Group>
        {/* <ImageCategories /> */}
        <ImagesInfinite filters={{ username, browsingMode }} withTags />
      </Stack>
    </Container>
  );
}
